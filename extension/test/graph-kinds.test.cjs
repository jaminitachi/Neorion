const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { execFileSync, spawnSync } = childProcess;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { buildSync } = require('esbuild');
const { Project, SyntaxKind } = require('ts-morph');
const { openMcp } = require('./mcp-helpers.cjs');
const { indexFile: indexPath } = require('./workspace-cache.cjs');

const entry = path.resolve(__dirname, '../../neorion/dist/neorion.cjs');
const source = path.join(__dirname, 'fixtures/impact-graph');
const cliSpawnTimeout = 180_000;

function fixture(t, reverse = false, fixtureSource = source) {
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
  copy(fixtureSource, root);
  const env = { ...process.env, XDG_CACHE_HOME: cache, LOCALAPPDATA: cache };
  const run = (args, extra = {}) => {
    const result = childProcess.spawnSync(process.execPath, [entry, ...args], {
      cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: cliSpawnTimeout
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trimEnd();
  };
  const query = (...args) => run(['query', ...args], { NEORION_AUTOBUILD: '0' });
  const build = () => {
    const overview = /^Overview: (.+)$/m.exec(run(['graph']))[1];
    return path.join(path.dirname(overview), indexPath);
  };
  return { root, env, run, query, build };
}

const stable = output => output.replace(/^Project: [^\n]+\n/, '')
  .replace(/index \d{4}-\d\d-\d\dT\d\d:\d\dZ/g, 'index TIMESTAMP');

function loadAnalyzer(name, compilerWalk) {
  const { outputFiles } = buildSync({
    entryPoints: [path.join(__dirname, '../src/core/analyzers', name + '.ts')],
    bundle: true, packages: 'external', platform: 'node', write: false,
    external: compilerWalk ? ['./CompilerWalk'] : []
  });
  const compiled = { exports: {} };
  new Function('module', 'require', outputFiles[0].text)(compiled, specifier =>
    specifier === './CompilerWalk' ? compilerWalk : require(specifier));
  return compiled.exports;
}

test('visitKinds preserves ts-morph wrapper identity, order, and skipped subtrees on both paths', t => {
  const { visitKinds } = loadAnalyzer('CompilerWalk');
  const file = new Project({ useInMemoryFileSystem: true }).createSourceFile('mixed.tsx', `
    /** Render a label.
     * @param label The label to render.
     * @returns A JSX element.
     */
    function Label({ label }: { label: string }) {
      const choose = (value: string) => value.trim();
      return <section><span>{choose(label)}</span><Icon /></section>;
    }
  `);
  const kinds = new Set([SyntaxKind.JSDoc, SyntaxKind.JSDocParameterTag, SyntaxKind.FunctionDeclaration,
    SyntaxKind.Identifier, SyntaxKind.ArrowFunction, SyntaxKind.CallExpression, SyntaxKind.JsxOpeningElement,
    SyntaxKind.JsxSelfClosingElement, SyntaxKind.JsxClosingElement]);
  const fn = file.getFunctionOrThrow('Label');
  assert.equal(fn.getJsDocs()[0].getTags().length, 2);
  const skipped = fn.getFirstDescendantByKindOrThrow(SyntaxKind.ArrowFunction).compilerNode;
  const forEachDescendant = file.forEachDescendant.bind(file);
  t.mock.method(file, 'forEachDescendant', () => assert.fail('the compiler path used the public walk'));
  let publicWalks = 0;
  // The pinned implementation's public walk still uses its own private wrapper factory.
  const fallback = {
    forEachDescendant(callback) {
      publicWalks++;
      return forEachDescendant(callback);
    }
  };

  for (const skip of [undefined, new Set([skipped])]) {
    const expected = [];
    const expectedRaw = [];
    forEachDescendant((node, traversal) => {
      expectedRaw.push(node.compilerNode);
      if (skip?.has(node.compilerNode)) traversal.skip();
      else if (kinds.has(node.getKind())) expected.push(node);
    });
    assert.ok(expected.includes(fn));
    assert.ok(expected.some(node => node.getKind() === SyntaxKind.JsxSelfClosingElement));

    for (const root of [file, fallback]) {
      const wrapped = [];
      const raw = [];
      visitKinds(root, kinds, node => wrapped.push(node), { skip, visitRaw: node => raw.push(node) });
      assert.equal(wrapped.length, expected.length);
      for (const [i, node] of expected.entries()) assert.equal(wrapped[i], node, `wrapper at ${i}`);
      assert.equal(raw.length, expectedRaw.length);
      for (const [i, node] of expectedRaw.entries()) assert.equal(raw[i], node, `compiler node at ${i}`);
    }
  }
  assert.equal(publicWalks, 2);
});

test('graph callbacks give the same results with and without their kind filters', t => {
  const { root } = fixture(t);
  const { visitKinds } = loadAnalyzer('CompilerWalk');
  const { RouteAnalyzer } = loadAnalyzer('RouteAnalyzer');
  const kindSets = new Set();
  let unfiltered;
  const { ComponentAnalyzer } = loadAnalyzer('ComponentAnalyzer', {
    visitKinds(node, kinds, callback, options = {}) {
      kindSets.add(kinds);
      if (!unfiltered?.has(kinds)) return visitKinds(node, kinds, callback, options);
      node.forEachDescendant((child, traversal) => {
        const raw = child.compilerNode;
        options.visitRaw?.(raw);
        if (options.skip?.has(raw)) traversal.skip();
        else callback(child);
      });
    }
  });
  fs.writeFileSync(path.join(root, '__tests__/kind-walk.test.tsx'), `
    import { html } from 'lit';
    import * as UI from '../components/providers';
    import * as helpers from '../lib/normalize';
    import { normalize } from '../lib/normalize';

    /** The normalize helper trims labels. */
    vi.mock('../lib/normalize', () => ({ normalize }));
    export async function InlineAction(label: string) {
      'use server';
      return normalize(label);
    }
    export const act = async (id: string) => {
      'use server';
      return fetch('/api/items/' + id);
    };

    // A standalone URL exercises the route-literal scan outside a fetch call.
    export const sampleItemUrl = '/api/items/' + 'example';

    function ActionButton({ actions }: { actions: { act: typeof act } }) {
      return <button onClick={() => actions.act('test')}>Fetch item</button>;
    }
    export function InlineButton() {
      const trim = helpers['normalize'];
      return <UI.Providers>
        <button onClick={() => InlineAction(trim('test'))}>Send</button>
        <ActionButton actions={{ act }} />
      </UI.Providers>;
    }
    export function renderPreview() {
      return html\`<span>Preview</span>\`;
    }
  `);
  fs.writeFileSync(path.join(root, 'server/kind-walk-router.ts'), `
    import { procedure, router } from './trpc';

    function listKindWalkItems() { return []; }
    export const kindWalkRouter = router({
      items: router({ list: procedure.query(listKindWalkItems) }),
    });
    export type KindWalkRouter = typeof kindWalkRouter;
  `);
  fs.writeFileSync(path.join(root, 'hooks/use-kind-walk-items.ts'), `
    import { createTRPCReact } from '@trpc/react-query';
    import type { KindWalkRouter } from '../server/kind-walk-router';

    const api = createTRPCReact<KindWalkRouter>();
    export function useKindWalkItems() { return api.items.list.useQuery(); }
  `);
  const project = new Project({ tsConfigFilePath: path.join(root, 'tsconfig.json') });
  const files = project.getSourceFiles().filter(file => !file.isDeclarationFile());
  const analyze = (files) => {
    const routes = new RouteAnalyzer(path.join(root, 'app'), path.join(root, 'pages'), root).analyze(files, []);
    const result = new ComponentAnalyzer(root).analyze(files, routes, true);
    delete result.index.generatedAt;
    return result;
  };

  const filtered = analyze(files);
  assert.equal(kindSets.size, 9);
  assert.ok(filtered.index.references.some(reference => reference[3] === 'mock'));
  assert.ok(filtered.index.serverActions.some(action => action.name === 'InlineAction' && action.callers.length));
  assert.ok(filtered.index.fetches.length);
  assert.ok(filtered.edges.some(edge => edge.type === 'renders'));
  const { symbols, references, trpcUses } = filtered.index;
  const procedure = symbols.find(symbol => symbol.name === 'items.list' && symbol.kind === 'procedure');
  const resolver = symbols.find(symbol => symbol.name === 'listKindWalkItems');
  const hook = symbols.find(symbol => symbol.name === 'useKindWalkItems');
  assert.ok(procedure && resolver && hook);
  assert.ok(Object.values(trpcUses).flat().some(([target, line, operation, owner]) =>
    target === procedure.id && line === hook.line && operation === 'useQuery' && owner === hook.id));
  assert.ok(references.some(([target, , , kind, , owner]) =>
    target === resolver.id && kind === 'call' && owner === procedure.id));
  for (const kinds of kindSets) {
    unfiltered = new Set([kinds]);
    assert.deepEqual(analyze(files), filtered, [...kinds].map(kind => SyntaxKind[kind]).join(', '));
  }

  const withoutActions = files.filter(file => !file.getFullText().includes('use server'));
  unfiltered = undefined;
  const filteredWithoutActions = analyze(withoutActions);
  assert.equal(filteredWithoutActions.index.serverActions.length, 0);
  unfiltered = kindSets;
  assert.deepEqual(analyze(withoutActions), filteredWithoutActions);
});

test('cached source lines match ts-morph at newline boundaries', () => {
  const { lineAt, startLine, endLine } = loadAnalyzer('SourceLines');
  const text = '/** docs */\r\nexport function foo() {\r\n  return 1;\r}\nconst bar = foo();\u2028bar;\u2029\n';
  const file = new Project({ useInMemoryFileSystem: true }).createSourceFile('mixed.ts', text);
  for (let offset = 0; offset <= text.length; offset++) {
    assert.equal(lineAt(file, offset), file.getLineAndColumnAtPos(offset).line, `offset ${offset}`);
  }
  file.forEachDescendant(node => {
    assert.equal(startLine(node), node.getStartLineNumber());
    assert.equal(endLine(node), node.getEndLineNumber());
  });
});

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
    const reversedOutput = reversed.query(kind, target, ...flags);
    assert.equal(output.split('\n')[0], `Project: ${root}`);
    assert.equal(reversedOutput.split('\n')[0], `Project: ${reversed.root}`);
    assert.equal(query(kind, target, ...flags), output);
    assert.equal(await mcp.text('query', { kind, target, ...options }), output);
    assert.equal(stable(reversedOutput), stable(output));
    assert.ok(Buffer.byteLength(output.split('\n').slice(1).join('\n')) <= 8000);
    return output;
  }
  const impact = await check('impact', 'normalize');
  assert.match(impact, /# risk: .*3 pages, 1 API.*1 layout; .*1 test$/m);
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
  assert.match(typeUse, /# stopped at 1 module-level use \(importers not traced\)/);
  assert.match(typeUse, /# partial: module-level importers not traced/);
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
  const chart = query('impact', 'components/chart.tsx#Chart');
  assert.match(chart, /^d1 dyn app\/\(main\)\/items\/page\.tsx:4 module$/m);
  assert.doesNotMatch(chart, /^d1 use app\/\(main\)\/items\/page\.tsx:4 Chart\b/m);
  assert.match(query('impact', 'parse'), /d1 call hooks\/use-items\.ts:4 onError/);
  assert.doesNotMatch(query('impact', 'parse'), /module lib\/normalize\.ts/);
  const targetAction = query('impact', 'submitItem');
  assert.match(targetAction, /depth 4 \(limit 3 \+ renders\/events\)/);
  assert.match(targetAction, /# target: server action createItem/);
  assert.match(targetAction, /0 server actions/);
  assert.doesNotMatch(targetAction, /^action createItem/m);
  const barrel = query('impact', 'CreateItem');
  assert.match(barrel, /page \/items/);
  assert.doesNotMatch(barrel, /components\/index\.ts/);
  const middleware = query('impact', 'middleware.ts');
  assert.match(middleware, /: 1 route,/);
  assert.match(middleware, /matcher: '\/items\/:path\*'/);

  const callees = await check('callees', 'createItem');
  assert.match(callees, /db\.\$transaction  server\/db\.ts#db/);
  assert.match(callees, /^d1 ext next\/cache  revalidatePath:\d+(?: ×\d+)?$/m);
  assert.match(callees, /: 2 project calls/);
  assert.match(callees, /^d1 call :7,10,11 \+1  normalize/m);
  assert.match(callees, /^# source: server\/actions\.ts \(unqualified first-hop sites\)$/m);
  assert.equal(callees.split('\n').filter(line => line.includes('  normalize  ')).length, 1);
  assert.match(callees, /^# partial: 1 unresolved call on local variables or parameters$/m);
  assert.doesNotMatch(callees, /anotherAction/);
  const limited = query('callees', 'createItem', '--limit', '1');
  assert.match(limited, /^# more: \d+ \(try .+neorion\.cjs'? query callees createItem --depth 1 --limit \d+ --root .+\)$/m);
  const limitedMcp = await mcp.text('query', { kind: 'callees', target: 'createItem', limit: 1 });
  assert.match(limitedMcp, /^# more: \d+ \(set limit=\d+ on the same request and keep the other arguments\)$/m);
  for (const output of [limited, limitedMcp]) {
    assert.match(output, /^# partial: output truncated; 1 unresolved call on local variables or parameters$/m);
  }
  assert.match(query('callees', 'CreateItem', '--depth', '2'), /d2 action .*createItem/);
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
  assert.match(impact, /200 callers in 1 file\b/);
  const actionImpact = query('impact', 'normalize');
  assert.match(actionImpact, /^actions: 7 in 1 file \(top: createItem /m);
  assert.match(actionImpact, /^page \/items.* via CreateItem > onSubmit/m);
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

test('path gives the shortest directed chain from a page, symbol, or layout', { timeout: cliSpawnTimeout }, async t => {
  const { root, env, query, build } = fixture(t);
  build();
  const directly = query('path', '/items', 'createItem');
  assert.match(directly, /: 3 hops /);
  assert.match(directly, /^0 route \/items.* Items$/m);
  assert.match(directly, /^1 render .*CreateItem \[when empty\] \[cond\]$/m);
  assert.match(directly, /^2 event .*onSubmit .*onClick <button Create>/m);
  assert.match(directly, /^3 action .*createItem -> server\/actions\.ts:6$/m);
  const fromFile = query('path', 'app/(main)/items/page.tsx', 'server/actions.ts#submitItem');
  assert.equal(fromFile, directly);
  const layout = query('path', '/other', 'createItem');
  assert.match(layout, /^1 wrap .*layout\.tsx:\d+ MainLayout$/m);
  assert.match(layout, /^6 action .*sidebar\.tsx:3 createItem/m);
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
  assert.match(create, /writeThroughFactory \(createCaller\)/);
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
  assert.match(upstream, /page \/trpc-cache/);
  assert.doesNotMatch(upstream, /useDynamic|unrelated/);
  assert.match(query('callees', 'useDynamic'), /# partial: tRPC procedure target unresolved/);
  assert.match(query('path', 'useDynamic', 'calculateTotal'), /# partial: tRPC procedure target unresolved/);

  const dynamic = query('api_consumers', 'server/trpc-other.ts#invoices.total');
  assert.match(dynamic, /0 caller sites/);
  assert.match(dynamic, /# partial: tRPC procedure target unresolved/);
  const total = query('api_consumers', target);
  assert.match(total, /6 caller sites, 2 cache-only/);
  assert.match(total, /readThroughRouter \(createCaller\)/);
  assert.match(total, /readThroughTransport \(query\)/);
  assert.match(total, /InvoicePanel \(useQuery\)/);
  assert.match(total, /InvoicePanel \(useSuspenseQuery\)/);
  for (const operation of ['invalidate', 'prefetch']) {
    assert.ok(total.split('\n').some(line => line.startsWith('cache-only app/trpc-cache/page.tsx:') && line.endsWith(`(${operation})`)));
  }
  assert.match(total, /^call app\/trpc-cache\/page\.tsx:\d+ CachePage \(fetch\) \[args 1\]$/m);
  assert.match(total, /^call app\/trpc-cache\/page\.tsx:\d+ CachePage \(ensureData\) \[args 1\]$/m);
  assert.match(query('api_consumers', target, '--limit', '1'), /^call app\/trpc-cache\/page\.tsx:\d+ CachePage \(fetch\) \[args 1\]$/m);
  assert.doesNotMatch(total, /unrelated/);
  assert.match(query('path', '/trpc-cache', target), /1 trpc .*invoices\.total .*\(fetch\)/);
  assert.match(query('path', '/trpc-cache', 'history.total'), /no directed path/);
});

test('tRPC traces batch hooks, TanStack options and hydration through merged and inline routers', { timeout: 40_000 }, t => {
  const { query, build } = fixture(t);
  build();
  const count = query('api_consumers', 'feed.count');
  assert.match(count, /2 caller sites, 2 cache-only/);
  assert.match(count, /^call .*useClassicBatch \(useQueries\)$/m);
  assert.match(count, /^call .*TrpcReviewPage \(count\)$/m);
  assert.match(count, /^cache-only .*useReactQueryOptions \(queryKey\)$/m);
  assert.match(count, /^cache-only .*useReactQueryOptions \(pathFilter\)$/m);
  assert.match(count, /# complete: indexed tRPC callers/);
  assert.doesNotMatch(count, /unrelatedBatch/);

  const item = query('api_consumers', 'feed.nested.deep.item');
  assert.match(item, /^call .*useClassicBatch \(useSuspenseQueries\)$/m);
  assert.match(item, /^cache-only .*TrpcReviewPage \(prefetch\)$/m);
  assert.match(item, /^cache-only .*useReactQueryOptions \(pathFilter\)$/m);
  assert.match(query('path', '/trpc-review', 'countFeed'), /1 trpc .*feed\.count[^\n]*\n2 call .*countFeed/);

  const stats = query('api_consumers', 'admin.stats');
  assert.match(stats, /3 caller sites/);
  assert.match(stats, /^call .*useClassicBatch \(useQueries\)$/m);
  assert.match(stats, /^call .*useReactQueryOptions \(queryOptions\)$/m);
  assert.match(stats, /^call .*useReactQueryOptions \(query\)$/m);
  assert.match(stats, /# complete: indexed tRPC callers/);
  assert.doesNotMatch(stats, /unrelatedBatch/);
  assert.match(query('api_consumers', 'admin.update'), /^call .*useReactQueryOptions \(mutationOptions\)$/m);
  assert.doesNotMatch(query('search', 'getRemoteCount'), /#getRemoteCount/);
});

test('tRPC reports skipped client forms and helper-built procedures as partial', { timeout: 40_000 }, t => {
  const { query, build } = fixture(t);
  build();
  const batch = query('api_consumers', 'batch.item');
  assert.match(batch, /0 caller sites/);
  assert.match(batch, /# partial: tRPC procedure target unresolved \(components\/trpc\/review-partial\.ts:/);
  assert.match(query('callees', 'useOpaqueBatch'), /# partial: tRPC procedure target unresolved/);

  const options = query('api_consumers', 'options.item');
  assert.match(options, /1 caller site/);
  assert.match(options, /^call .*useMixedOptions \(useQuery\)$/m);
  assert.match(options, /# partial: tRPC procedure target unresolved \(components\/trpc\/review-partial\.ts:/);
  assert.match(query('callees', 'useDynamicKey'), /# partial: tRPC procedure target unresolved/);

  assert.match(query('api_consumers', 'helper.direct'), /# partial: tRPC procedure target unresolved \(server\/trpc-review\.ts:/);
  assert.match(query('callees', 'useHelper'), /# partial: tRPC procedure target unresolved/);
  assert.doesNotMatch(query('search', 'helper.built'), /#helper\.built/);
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

test('changes allows a CLI launch to take longer than the old spawn timeout', t => {
  const { changes } = gitFixture(t);
  const spawn = t.mock.method(childProcess, 'spawnSync', (command, args, options) => {
    assert.ok(options.timeout > 30_000 && Number.isFinite(options.timeout));
    return spawnSync(command, args, options);
  });
  const output = changes();
  assert.match(output, /0 files, 0 symbols, 0 routes/);
  assert.equal(spawn.mock.callCount(), 1);
});

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
  assert.match(comments, /1 file, 0 symbols, 0 routes/);
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
  assert.doesNotMatch(wrappers, /wraps app\/\(main\)\/layout\.tsx#/);
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
  assert.equal(await mcp.text('query', { kind: 'changes', depth: 6 }), changes('--depth', '6'));
  assert.equal((await mcp.call('query', { kind: 'changes', depth: 7 })).isError, true);
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
  fs.writeFileSync(file('lib/untracked.ts'), 'export const onlyUntracked = 1;\n');
  const base = changes('--base', 'main');
  assert.match(base, /# changes merge-base main/);
  assert.match(base, /changed lib\/normalize\.ts:1-3 normalize/);
  assert.match(base, /changed components\/providers\.tsx:1 Providers/);
  assert.doesNotMatch(base, /untracked\.ts/);
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
  assert.match(removed, /# partial: could not trace 2 removals from base/);
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
  fs.writeFileSync(file('package.json'), '{"private":true}\n');
  fs.writeFileSync(file('.gitignore'), '.env*\n');
  git('add', 'package.json', '.gitignore');
  git('commit', '-qm', 'Nest the project');
  fs.writeFileSync(file('outside.ts'), 'export const outside = true;\n');
  fs.appendFileSync(file('nested/lib/normalize.ts'), '\nexport const fresh = 1;\n');
  const nested = run(['query', 'changes', '--root', path.join(root, 'nested')]);
  assert.match(nested, /# outside project: 1 file/);
  assert.match(nested, /changed lib\/normalize\.ts:10 fresh/);
  assert.doesNotMatch(nested, /outside\.ts/);
  fs.writeFileSync(file('package.json'), '{"private":false}\n');
  fs.writeFileSync(file('nested/.env.local'), 'ENV_VALUE=never-print-this\n');
  const config = run(['query', 'changes', '--root', path.join(root, 'nested')]);
  assert.match(config, /file package\.json \[repository config: all routes\]/);
  assert.match(config, /file \.env\.local \[config: all routes\]/);
  assert.doesNotMatch(config, /never-print-this/);
  assert.doesNotMatch(run(['query', 'changes', '--base', 'HEAD', '--root', path.join(root, 'nested')]), /\.env\.local/);
});

test('changes traces removed imports from the comparison side and prefers current routes', { timeout: 65_000 }, async t => {
  const { root, env, file, edit, git, run, changes } = gitFixture(t);
  fs.writeFileSync(file('lib/old.ts'), 'export function old() { return 1; }\nexport { old as retained };\n');
  fs.writeFileSync(file('lib/barrel.ts'), 'export { old as former } from "./old";\n');
  edit('app/(main)/other/page.tsx', text =>
    'import { former } from "../../../lib/barrel";\n' + text.replace('<main />', '<main>{former()}</main>'));
  edit('app/(main)/items/page.tsx', text =>
    'import { retained } from "../../../lib/old";\n' + text.replace('<main>', '<main>{retained()}'));
  git('add', '.');
  git('commit', '-qm', 'Add a page dependency');

  edit('lib/old.ts', text => text.replace('export function', 'function'));
  const narrowed = changes('--base', 'HEAD');
  assert.match(narrowed, /removed lib\/old\.ts old/);
  assert.match(narrowed, /importer app\/\(main\)\/other\/page\.tsx:.*\[base\]/);
  assert.match(narrowed, /importer lib\/barrel\.ts:1.*\[base\]/);
  assert.match(narrowed, /route page \/other .* <- old \[removed\]/);
  assert.doesNotMatch(narrowed, /route page \/items|removed lib\/old\.ts retained/);
  git('restore', '.');

  fs.unlinkSync(file('lib/old.ts'));
  fs.unlinkSync(file('app/(main)/other/page.tsx'));
  const removed = changes('--unstaged');
  assert.match(removed, /route page \/other .*\[base\].*lib\/old\.ts \[removed\]/);
  assert.match(removed, /deleted lib\/old\.ts/);
  assert.doesNotMatch(removed, /\[stale\]/);
  const traceFile = file('.git/warm-trace.jsonl');
  assert.equal(run(['query', 'changes', '--unstaged'], { GIT_TRACE2_EVENT: traceFile }), removed);
  const readTreeBlobs = () => fs.readFileSync(traceFile, 'utf8').trim().split('\n').map(JSON.parse)
    .filter(event => event.event === 'start' && event.argv.includes('cat-file')).length;
  assert.equal(readTreeBlobs(), 0);
  const bundle = path.join(__dirname, '../out/mcp.cjs');
  const mcp = await openMcp(t, root, { command: process.execPath, args: [bundle, '--root', root], cwd: root, env });
  assert.equal(await mcp.text('query', { kind: 'changes', scope: 'unstaged' }), removed.split('\n').slice(1).join('\n'));
  git('add', 'app/(main)/other/page.tsx');
  const newComparison = run(['query', 'changes', '--unstaged'], { GIT_TRACE2_EVENT: traceFile });
  assert.equal(readTreeBlobs(), 1);
  assert.doesNotMatch(newComparison, /^route page \/other /m);
});

test('changes traces a retained deletion beside an export removal and finds old-path importers after renames', { timeout: 65_000 }, t => {
  const { file, edit, git, changes } = gitFixture(t);
  const shared = 'lib/review-shared.ts';
  fs.writeFileSync(file(shared), [
    'export function removed() { return 1; }',
    '',
    'export function retained() {',
    '  const result = 2;',
    '  console.info(result);',
    '  return result;',
    '}',
    ''
  ].join('\n'));
  const route = suffix => 'app/api/review-' + suffix + '/route.ts';
  for (const [suffix, name] of [['a', 'removed'], ['b', 'retained']]) {
    fs.mkdirSync(path.dirname(file(route(suffix))), { recursive: true });
    fs.writeFileSync(file(route(suffix)), [
      'import { ' + name + ' } from "../../../lib/review-shared";',
      'export function GET() { return Response.json(' + name + '()); }',
      ''
    ].join('\n'));
  }
  git('add', '.');
  git('commit', '-qm', 'Add separate review routes');
  edit(shared, text => text.replace('export function removed', 'function removed').replace('  console.info(result);\n', ''));
  const both = changes();
  assert.match(both, /1 file, 1 symbol, 2 routes/);
  assert.match(both, /^route api GET \/api\/review-a .* <- removed \[removed\] d1/m);
  assert.match(both, /^route api GET \/api\/review-b .* <- retained d1/m);
  assert.match(both, /^changed lib\/review-shared\.ts:3-6 retained \+0 -1$/m);
  assert.match(both, /# complete:/);

  git('restore', shared);
  git('mv', shared, 'lib/review-moved.ts');
  const moved = changes('--staged');
  for (const suffix of ['a', 'b']) {
    assert.match(moved, new RegExp('^route api GET /api/review-' + suffix + ' .*review-shared\\.ts \\[renamed\\]', 'm'));
    assert.match(moved, new RegExp('^importer ' + route(suffix) + ':.* <- renamed lib/review-shared\\.ts \\[base\\]', 'm'));
    edit(route(suffix), text => text.replace('review-shared', 'review-moved'));
  }
  assert.doesNotMatch(moved, /^removed /m);
  git('add', '.');
  const current = changes('--staged');
  assert.match(current, /3 files, 0 symbols, 2 routes/);
  assert.doesNotMatch(current, /^importer .*\[base\]/m);
  assert.match(current, /^# complete:/m);
});

test('changes traces an unindexed binding from its importer and reports other uncovered removals', { timeout: 65_000 }, t => {
  const { file, edit, git, changes } = gitFixture(t);
  for (const [suffix, name] of [['unindexed', '검토'], ['indexed', 'known'], ['unreached', '누락']]) {
    fs.writeFileSync(file('lib/' + suffix + '.ts'), 'export function ' + name + '() { return 1; }\n');
    const folder = 'app/api/' + suffix;
    if (suffix === 'unreached') {
      fs.writeFileSync(file('lib/disconnected.ts'), 'import { 누락 } from "./unreached";\n누락();\n');
    } else {
      fs.mkdirSync(file(folder), { recursive: true });
      fs.writeFileSync(file(folder + '/route.ts'), [
        'import { ' + name + ' } from "../../../lib/' + suffix + '";',
        'export function GET() { return Response.json(' + name + '()); }',
        ''
      ].join('\n'));
    }
  }
  git('add', '.');
  git('commit', '-qm', 'Add indexed and unindexed bindings');
  for (const suffix of ['unindexed', 'indexed', 'unreached']) {
    edit('lib/' + suffix + '.ts', text => text.replace('export function', 'function'));
  }
  const output = changes();
  assert.match(output, /^route api GET \/api\/unindexed .* <- 검토 \[removed\] d1/m);
  assert.match(output, /^route api GET \/api\/indexed .* <- known \[removed\] d1/m);
  assert.match(output, /^file lib\/unindexed\.ts:1 \+1 -1$/m);
  assert.match(output, /^file lib\/indexed\.ts:1 \+1 -1$/m);
  assert.match(output, /^importer lib\/disconnected\.ts:1 <- removed 누락 \[base\]/m);
  assert.match(output, /# partial: no page or API routes traced for removals$/);
});

test('changes traces value re-exports converted to type-only exports', { timeout: 65_000 }, t => {
  const { file, edit, git, changes } = gitFixture(t);
  const barrel = 'lib/barrel.ts';
  fs.writeFileSync(file('lib/leaf.ts'), 'export function leaf() { return 42; }\n');
  fs.writeFileSync(file(barrel), 'export { leaf } from "./leaf";\n');
  fs.mkdirSync(file('app/api/barrel'), { recursive: true });
  fs.writeFileSync(file('app/api/barrel/route.ts'),
    'import { leaf } from "../../../lib/barrel";\nexport function GET() { return Response.json(leaf()); }\n');
  git('add', '.');
  git('commit', '-qm', 'Add a runtime re-export and its route');

  for (const declaration of ['export type { leaf }', 'export { type leaf }']) {
    edit(barrel, () => declaration + ' from "./leaf";\n');
    const output = changes();
    assert.match(output, /^route api GET \/api\/barrel .* <- leaf \[removed\] d1/m);
    assert.match(output, /^removed lib\/barrel\.ts leaf$/m);
    assert.match(output, /^importer app\/api\/barrel\/route\.ts:1,2 <- removed leaf \[base\]$/m);
    assert.match(output, /# complete:/);
  }

  edit(barrel, text => text.replace('export { type leaf }', 'export { leaf }').replace('./leaf', './missing'));
  const partial = changes();
  assert.doesNotMatch(partial, /^route api GET \/api\/barrel /m);
  assert.match(partial, /^export lib\/barrel\.ts leaf \[uncertain\]$/m);
  assert.match(partial, /^importer app\/api\/barrel\/route\.ts:1,2 <- possible removal of leaf \[base\] \[uncertain\]$/m);
  assert.match(partial, /^# partial: .*runtime export availability not resolved$/m);

  edit(barrel, () => 'export * from "./leaf";\n');
  git('add', barrel);
  git('commit', '-qm', 'Export the same value through a wildcard');
  edit(barrel, text => text.replace('export *', 'export type *'));
  const wildcard = changes();
  assert.match(wildcard, /^route api GET \/api\/barrel .* <- leaf \[removed\] d1/m);
  assert.match(wildcard, /# complete:/);
});

test('changes traces named and namespace importers of the same removed export', { timeout: 65_000 }, t => {
  const { file, edit, git, changes } = gitFixture(t);
  const binding = 'lib/flags.ts';
  fs.writeFileSync(file(binding), 'export function 검토() { return 1; }\n');
  const imports = [
    ['named', 'import { 검토 }', '검토()'],
    ['namespace', 'import * as flags', 'flags.검토()'],
    ['literal-member', 'import * as flags', '(flags)["검토"]()'],
    ['destructured', 'import * as flags', '(() => { const { 검토: run } = flags; return run(); })()']
  ];
  for (const [name, declaration, use] of imports) {
    const dir = 'app/api/' + name;
    fs.mkdirSync(file(dir), { recursive: true });
    fs.writeFileSync(file(dir + '/route.ts'), declaration + ' from "../../../lib/flags";\n' +
      'export function GET() { return Response.json(' + use + '); }\n');
  }
  git('add', '.');
  git('commit', '-qm', 'Import one binding with named and namespace imports');
  const remove = () => edit(binding, text => text.replace('export function', 'function'));
  remove();
  const output = changes();
  for (const [name] of imports) {
    assert.match(output, new RegExp('^route api GET /api/' + name + ' .* <- 검토 \\[removed\\] d1', 'm'));
    assert.match(output, new RegExp('^importer app/api/' + name + '/route\\.ts:.* <- removed 검토 \\[base\\]$', 'm'));
  }
  assert.match(output, /# complete:/);

  git('restore', binding);
  fs.mkdirSync(file('app/api/dynamic'), { recursive: true });
  fs.writeFileSync(file('app/api/dynamic/route.ts'), 'import * as flags from "../../../lib/flags";\n' +
    'export function GET(request: Request) { return Response.json(flags[request.url]()); }\n');
  git('add', '.');
  git('commit', '-qm', 'Add a dynamically selected namespace member');
  remove();
  const partial = changes();
  assert.match(partial, /^route api GET \/api\/named /m);
  assert.doesNotMatch(partial, /^route api GET \/api\/dynamic /m);
  assert.match(partial, /^importer app\/api\/dynamic\/route\.ts:1,2 <- removed 검토 \[base\] \[uncertain\]$/m);
  assert.match(partial, /^# partial: .*namespace.*$/m);

  git('restore', binding);
  fs.writeFileSync(file('lib/dormant.ts'), 'import * as flags from "./flags";\n' +
    'export function dormant() { return flags.검토(); }\n');
  git('add', '.');
  git('commit', '-qm', 'Add a namespace importer with no route');
  remove();
  const dormant = changes();
  assert.match(dormant, /^route api GET \/api\/named /m);
  assert.match(dormant, /^importer lib\/dormant\.ts:1,2 <- removed 검토 \[base\] \[uncertain\]$/m);
  assert.match(dormant, /^# partial: .*no page or API routes traced for removals/m);
});

test('changes restores direct base importers incrementally and falls back for a namespace', { timeout: 65_000 }, t => {
  const { env, file, edit, git, changes, run } = gitFixture(t);
  const origin = 'lib/history-origin.ts';
  const api = 'app/api/history';
  fs.writeFileSync(file(origin), 'export function original() {}\nexport const retained = 1;\n');
  fs.mkdirSync(file(api), { recursive: true });
  fs.writeFileSync(file(api + '/route.ts'), 'import { original as work } from "../../../lib/history-origin";\n' +
    'export function GET() { work(); return Response.json({}); }\n');
  fs.writeFileSync(file('lib/history-origin.test.ts'), 'import { original } from "./history-origin";\noriginal();\n');
  fs.mkdirSync(file('app/history'), { recursive: true });
  fs.writeFileSync(file('app/history/page.tsx'), 'export default function History() { fetch("/api/history"); return <main/>; }\n');
  git('add', '.');
  git('commit', '-qm', 'Create a route and test that call the same named export');

  const history = path.join(env.XDG_CACHE_HOME, 'neorion');
  const onDisk = () => fs.readdirSync(history).flatMap(key => {
    const directory = path.join(history, key, 'history');
    return fs.existsSync(directory) ? fs.readdirSync(directory).filter(file => file.endsWith('.json'))
      .map(file => JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'))) : [];
  });
  const traceFile = file('.git/scoped-history-trace.jsonl');
  const tracedChanges = () => run(['query', 'changes'], { GIT_TRACE2_EVENT: traceFile });
  const baseBuilds = () => fs.readFileSync(traceFile, 'utf8').trim().split('\n').map(JSON.parse)
    .filter(event => event.event === 'start' && event.argv.includes('cat-file')).length;
  edit(origin, text => text.replace('export function', 'function'));
  const scoped = tracedChanges();
  assert.match(scoped, /^route api GET \/api\/history .* <- original \[removed\] d1/m);
  assert.match(scoped, /^route page \/history .* <- original \[removed\].*via fetch/m);
  assert.match(scoped, /^importer app\/api\/history\/route\.ts:1,2 <- removed original \[base\]$/m);
  assert.match(scoped, /^importer lib\/history-origin\.test\.ts:1,2 <- removed original \[base\]$/m);
  assert.match(scoped, /^# complete:/m);
  assert.equal(onDisk().length, 1);
  assert.ok(onDisk()[0].projectSnapshot);
  const builds = baseBuilds();
  assert.ok(builds > 0);
  assert.equal(stable(tracedChanges()), stable(scoped));
  assert.equal(baseBuilds(), builds);

  // An ignored compiler input absent from the base invalidates live graph reuse.
  fs.appendFileSync(file('.git/info/exclude'), '\n/history-local.d.ts\n');
  fs.writeFileSync(file('history-local.d.ts'), 'export {};\n');
  assert.equal(stable(tracedChanges()), stable(scoped));
  assert.ok(baseBuilds() > builds);
  assert.equal(onDisk().length, 2);
  assert.equal(onDisk().filter(index => index.projectSnapshot).length, 1);

  git('restore', origin);
  fs.writeFileSync(file(api + '/route.ts'), 'import * as library from "../../../lib/history-origin";\n' +
    'export function GET(request: Request) { library[request.url](); return Response.json({}); }\n');
  git('add', api);
  git('commit', '-qm', 'Use an opaque namespace property in the route');
  fs.unlinkSync(file('history-local.d.ts'));
  edit(origin, text => text.replace('export function', 'function'));
  const unresolved = changes();
  assert.match(unresolved, /^importer app\/api\/history\/route\.ts:1,2 .* \[uncertain\]$/m);
  assert.match(unresolved, /^# partial: .*namespace/m);
  assert.equal(onDisk().length, 3);
  assert.equal(onDisk().filter(index => index.projectSnapshot).length, 1);
});

test('changes skips a historical graph when the middleware matcher stays the same', { timeout: 65_000 }, t => {
  const { edit, git, run, file } = gitFixture(t);
  edit('middleware.ts', text => text.replace('middleware() {}', 'middleware() {\n  const response = new Response();\n  return response;\n}'));
  git('add', '.');
  git('commit', '-qm', 'Add a middleware body with a static matcher');

  const traceFile = file('.git/middleware-trace.jsonl');
  const readTreeBlobs = () => fs.readFileSync(traceFile, 'utf8').trim().split('\n').map(JSON.parse)
    .filter(event => event.event === 'start' && event.argv.includes('cat-file')).length;
  const changes = () => run(['query', 'changes'], { GIT_TRACE2_EVENT: traceFile });
  edit('middleware.ts', text => text.replace('return response;', 'return NextResponse.next();'));
  const body = changes();
  assert.match(body, /1 file, 1 symbol, 1 route/);
  assert.match(body, /matcher: '\/items\/:path\*'/);
  assert.match(body, /# complete:/);
  assert.equal(readTreeBlobs(), 0);

  edit('middleware.ts', text => text.replace("'/items/:path*'", '"/items/:path*"'));
  assert.match(changes(), /1 route, 0 wrappers/);
  assert.equal(readTreeBlobs(), 0);

  edit('middleware.ts', text => text.replace('/items/', '/other/'));
  assert.match(changes(), /1 route no longer matched, 1 route newly matched/);
  assert.equal(readTreeBlobs(), 1);
});

test('changes includes middleware matches from both sides and reports unknown coverage', { timeout: 65_000 }, t => {
  const { edit, git, changes } = gitFixture(t);
  edit('middleware.ts', text => text.replace('/items/', '/other/'));
  const narrower = changes();
  assert.match(narrower, /1 file, 1 symbol, 2 routes/);
  assert.match(narrower, /1 route no longer matched, 1 route newly matched/);
  assert.match(narrower, /# complete:/);

  edit('middleware.ts', text => text.replace("['/other/:path*']", "[{ source: '/other', has: [] }]"));
  const unknownCurrent = changes();
  assert.match(unknownCurrent, /1 file, 1 symbol, 1 route/);
  assert.match(unknownCurrent, /# partial: middleware matcher coverage not enumerated$/);
  git('add', 'middleware.ts');
  edit('middleware.ts', text => text.replace("[{ source: '/other', has: [] }]", "['/other/:path*']"));
  const unknownPrevious = changes('--unstaged');
  assert.match(unknownPrevious, /1 file, 1 symbol, 1 route/);
  assert.match(unknownPrevious, /# partial: middleware matcher coverage not enumerated$/);
  git('restore', '--staged', '--worktree', 'middleware.ts');

  edit('middleware.ts', text => text.replace(/^export const config.*\n/m, ''));
  const defaultMatcher = changes();
  assert.match(defaultMatcher, /previous matcher: '\/items\/:path\*', 0 routes no longer matched, [1-9]\d* routes? newly matched/);
  assert.equal(defaultMatcher.split('\n').filter(line => line.startsWith('middleware middleware.ts ')).length, 1);
  assert.match(defaultMatcher, /# complete:/);
});

test('changes handles top-level edits, reports module stops and can rerun deeper', { timeout: 65_000 }, t => {
  const { file, edit, git, query, changes } = gitFixture(t);
  const filePath = 'lib/deep.ts';
  fs.writeFileSync(file(filePath), [
    'export function start() { return 1; }',
    'export function one() { return start(); }',
    'export function two() { return one(); }',
    'export function three() { return two(); }',
    'export function four() { return three(); }',
    'export const stopped = { callback: () => start() };',
    'export const text = `line',
    '// looks like a comment',
    'end`;',
    ''
  ].join('\n'));
  const page = 'app/(main)/other/page.tsx';
  edit(page, text => 'import { four } from "../../../lib/deep";\n' + text.replace('<main />', '<main>{four()}</main>'));
  git('add', '.');
  git('commit', '-qm', 'Add deeper callers');

  edit(filePath, text => text.replace('return 1', 'return 2'));
  const shallow = changes();
  assert.match(shallow, /# partial: depth limit .*rerun --depth 5/);
  assert.match(shallow, /# stopped at 1 module-level use \(importers not traced\)/);
  assert.doesNotMatch(shallow, /route page \/other/);
  assert.match(changes('--depth', '6'), /route page \/other .*start d5/);
  const limited = changes('--depth', '6', '--unstaged', '--limit', '1');
  assert.match(limited, /^# more: 1 \(try .+ query changes --depth 6 --unstaged --limit 2 --root .+, or narrow the diff\)$/m);
  assert.match(limited, /^# partial: output truncated; module-level importers not traced$/m);
  assert.match(query('impact', 'start'), /# stopped at 1 module-level use/);
  git('restore', '.');

  edit(page, text => text.replace('{ four }', '{ four as old, four }'));
  assert.match(changes(), /route page \/other .*page\.tsx d0/);
  git('restore', '.');
  edit(filePath, text => text.replace('// looks like a comment', '// changes the string'));
  assert.doesNotMatch(changes(), /\[comment only\]/);
  edit(filePath, text => text.replace('// changes the string', '// looks like a comment').replace('export const text', '\nexport const text'));
  assert.doesNotMatch(changes(), /\[comment only\]/);
  git('restore', '.');
  edit(filePath, text => '// project note\n' + text);
  assert.match(changes(), /comment lib\/deep\.ts:1 \[comment only\]/);
});

test('packing and unpacking the graph preserves default-suite query output', { timeout: 35_000 }, t => {
  const { query, build, root } = fixture(t);
  const pagesApi = path.join(root, 'pages/api');
  fs.mkdirSync(pagesApi, { recursive: true });
  fs.writeFileSync(path.join(pagesApi, 'enforced.ts'), `export default function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();
    return res.status(200).end();
  }`);
  const indexFile = build();
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  const { outputFiles } = buildSync({
    entryPoints: [path.join(__dirname, '../src/mcp/GraphStorage.ts')],
    bundle: true, platform: 'node', write: false
  });
  const compiled = { exports: {} };
  new Function('module', 'require', outputFiles[0].text)(compiled, require);
  const { packGraph, unpackGraph } = compiled.exports;
  const queries = [['impact', 'normalize'], ['callees', 'createItem'], ['path', '/items', 'createItem'],
    ['search', 'getData'], ['impact', 'feed.nested.deep.item'], ['api_consumers', '/api/enforced']];
  const expected = queries.map(args => query(...args));
  assert.match(expected.at(-1), /^# methods enforced: POST$/m);
  const packed = packGraph(index, 0);
  assert.equal(typeof packed.packedGraph, 'string');
  assert.equal(packed.graphReferences, undefined);
  const restored = unpackGraph(JSON.parse(JSON.stringify(packed)));
  assert.deepEqual(restored.exportSymbols, index.exportSymbols);
  assert.deepEqual(restored.moduleImports, index.moduleImports);
  assert.deepEqual(restored.runtimeExports, index.runtimeExports);
  assert.deepEqual(restored.trpcModuleUses, index.trpcModuleUses);
  fs.writeFileSync(indexFile, JSON.stringify(packed));
  assert.deepEqual(queries.map(args => query(...args)), expected);
});


test('queries preserve scoped JSX values, callback registrations and store effects', { timeout: 40_000 }, t => {
  const { build, query, root } = fixture(t, false, path.join(__dirname, 'fixtures/prop-flow'));
  const indexFile = build();
  const { packGraph } = loadAnalyzer('../../mcp/GraphStorage');
  const unpacked = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  const packed = packGraph(unpacked, 0);
  assert.ok(packed.references.some(([, file]) => typeof file === 'number'));
  fs.writeFileSync(indexFile, JSON.stringify(packed));

  const render = query('who_renders', 'Leaf');
  assert.match(render, /\/primary.*prop body via ForwardPanel > RenderPanel/);
  assert.doesNotMatch(render, /\/secondary|\/opaque/);
  assert.match(query('who_renders', 'IconMark'), /\/primary.*prop Badge via RenderPanel/);
  assert.match(query('who_renders', 'UntracedLeaf'), /# partial: JSX prop render untraced/);
  assert.match(query('who_renders', 'Busy'), /\/primary.*prop fallback via React Suspense.*\[cond\]/);
  for (const component of ['TooltipContent', 'DayOverride', 'TriggerButton', 'QuotedContent', 'Panel']) {
    assert.match(query('who_renders', component), /^\/fallback\s/m);
  }
  assert.doesNotMatch(query('who_renders', 'UnusedContent'), /^\/fallback\s/m);
  assert.match(query('impact', 'runFallback'), /^page \/fallback\s/m);

  const requests = query('api_consumers', '/api/items/[id]');
  assert.match(requests, /update PATCH fetch via prop endpoint/);
  assert.match(requests, /remove DELETE fetch via prop endpoint/);
  assert.match(requests, /onClick <button Update> -> update/);
  assert.match(requests, /onClick <button Remove> -> remove/);
  assert.match(requests, /ListRow in Active/);
  assert.match(requests, /ListRow in Pending/);
  assert.doesNotMatch(requests, /^page .*\/secondary/m);
  assert.match(query('path', '/secondary', '/api/items/[id]'), /no directed path/);
  assert.match(query('path', '/primary', '/api/items/[id]'), /fetch .*PATCH|fetch .*DELETE/);
  const unknownUrl = query('path', '/opaque', '/api/items/[id]');
  assert.match(unknownUrl, /fetch .*\[partial url\]/);
  assert.match(unknownUrl, /^# partial: prop value untraced at a render site$/m);
  const directBinding = query('path', '/nonjsx', '/api/flags/[id]');
  assert.match(directBinding, /fetch .*via prop endpoint at app\/nonjsx\/page\.tsx:/);
  assert.match(directBinding, /^# complete:/m);
  const opaqueBinding = query('path', '/nonjsx-opaque', '/api/flags/[id]');
  assert.match(opaqueBinding, /no directed path/);
  assert.match(opaqueBinding, /^# partial: request URL from JSX prop untraced$/m);
  assert.match(query('path', '/nonjsx-opaque', '/api/unrelated'), /^# complete:/m);
  assert.match(query('api_consumers', '/api/family/[id]'), /^# partial: request URL from JSX prop untraced$/m);
  assert.match(query('impact', 'app/api/family/[id]/route.ts#GET'), /request URL from JSX prop untraced/);
  const details = path.resolve(path.dirname(indexFile), '../neorion/graph');
  const markdown = fs.readdirSync(details).map(file => fs.readFileSync(path.join(details, file), 'utf8')).join('\n');
  assert.match(markdown, /fetch app\/unrelated\/page\.tsx -> app\/api\/family\/\[id\]\/route\.ts \/api\/family\/\[id\]/);
  for (const args of [
    ['api_consumers', '/api/unrelated'],
    ['impact', 'app/api/unrelated/route.ts#GET'],
    ['api_consumers', 'finishUnrelated'],
    ['impact', 'unrelatedHelper']
  ]) assert.match(query(...args), /^# complete:/m);
  assert.match(query('callees', 'handle'), /^# partial:.*prop callback untraced/m);

  assert.doesNotMatch(query('search', 'onClick'), /#onClick/);
  assert.match(query('search', 'onClick', '--kind', 'function'), /#onClick button Start \/ Restart/);
  assert.match(query('impact', 'onClick button Start / Restart'), /^page \/unrelated\s/m);

  const impact = query('impact', 'publishPrimary', '--depth', '6');
  assert.match(impact, /^page \/primary\s/m);
  assert.match(impact, /^page \/nonjsx\s/m);
  assert.match(impact, /^page \/nonjsx-opaque\s/m);
  assert.doesNotMatch(impact, /^page \/secondary\s/m);
  assert.match(query('path', '/secondary', 'publishPrimary'), /no directed path/);
  assert.match(query('path', '/primary', 'persistRecord'), /RequestPanel[\s\S]*onClick <button Publish>[\s\S]*persistRecord/);
  assert.match(query('path', '/secondary', 'persistRecord'), /no directed path/);

  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '--quiet');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '-m', 'Fixture');
  const actions = path.join(root, 'lib/actions.ts');
  fs.writeFileSync(actions, fs.readFileSync(actions, 'utf8')
    .replace('publishPrimary() {}', 'publishPrimary() { return true; }')
    .replace('runFallback() {}', 'runFallback() { return true; }'));
  build();
  const changes = query('changes', '--unstaged', '--depth', '6');
  assert.match(changes, /page \/primary\s/);
  assert.match(changes, /page \/fallback\s/);
  assert.doesNotMatch(changes, /page \/secondary\s/);

  const capture = query('path', '/jobs', 'captureNode');
  assert.match(capture, /makeSnapshot \(onClick <button Snapshot>\)/);
  assert.match(capture, /createCapture .*useJobControls > useJobStore > bindings/);
  assert.match(capture, /callback ref ui\/jobs\.tsx:\d+ \(key key\)/);
  assert.match(capture, /argument refs\.get\(key\)/);
  assert.match(query('path', 'useJobStore', 'captureNode'), /no directed path/);

  const sync = query('api_consumers', 'syncJobs');
  assert.match(sync, /call .* start\nevent .*Start jobs/);
  assert.match(sync, /call .* retry\ncall .* -> retry \(via useJobControls.*\)\nevent .*Retry job/);
  assert.match(sync, /page \/jobs\s/);
});

test('default impact depth follows effect locals, sibling handlers and scoped callback props', { timeout: 40_000 }, t => {
  const { build, query, root } = fixture(t, false, path.join(__dirname, 'fixtures/prop-flow'));
  const write = (relative, source) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
  };
  write('lib/local-actions.ts', `
    'use server';
    function effectTarget() {}
    function load() { effectTarget(); }
    export async function effectAction() { load(); }
    function handlerTarget() {}
    function save() { handlerTarget(); }
    export async function handlerAction() { save(); }
    function remoteTarget() {}
    function remoteOne() { remoteTarget(); }
    function remoteTwo() { remoteOne(); }
    export async function remoteAction() { remoteTwo(); }
  `);
  write('ui/local.tsx', `
    'use client';
    import { useEffect } from 'react';
    import { effectAction, handlerAction, remoteAction } from '../lib/local-actions';
    export function EffectPanel() {
      useEffect(() => { const f = async () => { await effectAction(); }; f(); }, []);
      return <span/>;
    }
    export function Dialog({ onRun }: { onRun: () => void }) {
      const submit = () => onRun();
      return <button onClick={() => submit()}>Run</button>;
    }
    export function HandlerPanel() {
      const save = () => handlerAction();
      const run = () => save();
      return <Dialog onRun={run}/>;
    }
    export function RemotePanel() {
      const remote = () => remoteAction();
      return <button onClick={remote}>Remote</button>;
    }
  `);
  write('app/local/layout.tsx', `
    import { EffectPanel } from '../../ui/local';
    export default function Layout({ children }) { return <><EffectPanel/>{children}</>; }
  `);
  write('app/local/page.tsx', 'export default function Page() { return <main/>; }');
  write('app/handlers/page.tsx', `
    import { HandlerPanel } from '../../ui/local';
    export default function Page() { return <HandlerPanel/>; }
  `);
  write('app/other/page.tsx', `
    import { Dialog, RemotePanel } from '../../ui/local';
    export default function Page() { return <><Dialog onRun={() => {}}/><RemotePanel/></>; }
  `);
  const indexFile = build();
  const { packGraph } = loadAnalyzer('../../mcp/GraphStorage');
  fs.writeFileSync(indexFile, JSON.stringify(packGraph(JSON.parse(fs.readFileSync(indexFile, 'utf8')), 0)));

  const effect = query('impact', 'effectTarget');
  assert.match(effect, /^layout app\/local\/layout\.tsx +wraps 1 route \(\/local\)/m);
  assert.match(effect, /^d3 call .*EffectPanel < f$/m);
  assert.match(effect, /^# complete:/m);
  const handler = query('impact', 'handlerTarget');
  assert.match(handler, /^page \/handlers\s/m);
  assert.doesNotMatch(handler, /^page \/other\s/m);
  assert.match(handler, /^# complete:/m);
  const remote = query('impact', 'remoteTarget');
  assert.doesNotMatch(remote, /^page \/other\s/m);
  assert.match(remote, /^# partial: depth limit/m);
  assert.match(query('impact', 'remoteTarget', '--depth', '4'), /^page \/other\s/m);
});

test('component lookup maps resolve static keys and label unresolved choices', { timeout: 40_000 }, t => {
  const { build, query, root } = fixture(t, false, path.join(__dirname, 'fixtures/prop-flow'));
  fs.writeFileSync(path.join(root, 'ui/lookup.tsx'), `
    export function Multi() { return <span/>; }
    export function Ghost() { return <span/>; }
    export function Exact() { return <span/>; }
    export const MAP = { m: Multi, g: Ghost } as const;
    export const EXACT = { a: Exact, b: Ghost } as const;
    export function LookupLeaf() { return <span/>; }
    export function touch() {}
    function Receiver({ slot, ...props }) { return <div {...props}>{slot}</div>; }
    function Ignorer() { return <div/>; }
    export const RECEIVERS = { a: Receiver, b: Ignorer } as const;
  `);
  const page = (name, source) => {
    const directory = path.join(root, 'app', name);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'page.tsx'), source);
  };
  page('h', `
    import { MAP } from '../../ui/lookup';
    export default function Page({ k }: { k: keyof typeof MAP }) { const C = MAP[k]; return <C/>; }
  `);
  page('known-key', `
    import { EXACT } from '../../ui/lookup';
    const key = 'a';
    export default function Page() { const C = EXACT[key]; return <C/>; }
  `);
  page('known-property', `
    import { EXACT } from '../../ui/lookup';
    export default function Page() { return <EXACT.a/>; }
  `);
  page('create-element', `
    import { createElement } from 'react';
    import { MAP } from '../../ui/lookup';
    export default function Page() { return createElement(MAP['m']); }
  `);
  page('lookup-props', `
    import { LookupLeaf, RECEIVERS, touch } from '../../ui/lookup';
    export default function Page({ k }: { k: keyof typeof RECEIVERS }) {
      const C = RECEIVERS[k];
      return <C slot={<LookupLeaf/>} onClick={touch}/>;
    }
  `);
  const indexFile = build();
  const multi = query('who_renders', 'Multi');
  assert.match(multi, /^\/h\s.*\[possible\]/m);
  assert.match(multi, /^\/create-element\s[^\n]*depth 1$/m);
  const ghost = query('who_renders', 'Ghost');
  assert.match(ghost, /^\/h\s.*\[possible\]/m);
  assert.doesNotMatch(ghost, /^\/(known-|create-element)/m);
  for (const output of [multi, ghost, query('impact', 'Ghost'), query('path', '/h', 'Ghost')]) {
    assert.match(output, /^# partial: component lookup key untraced/m);
  }
  const exact = query('who_renders', 'Exact');
  assert.match(exact, /^\/known-key\s/m);
  assert.match(exact, /^\/known-property\s/m);
  assert.doesNotMatch(exact, /\[possible\]/);
  assert.match(exact, /^# complete:/m);
  const slot = query('who_renders', 'LookupLeaf');
  assert.match(slot, /^\/lookup-props\s.*prop slot via Receiver.*\[possible\]/m);
  assert.match(slot, /^# partial: component lookup key untraced/m);
  const event = query('impact', 'touch');
  assert.match(event, /^page \/lookup-props\s.*\[possible\]/m);
  assert.match(event, /^# partial: component lookup key untraced/m);
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  index.graphRevision--;
  fs.writeFileSync(indexFile, JSON.stringify(index));
  assert.match(query('who_renders', 'Exact'), /^# partial: regenerate index for component lookup coverage$/m);
  build();
  assert.match(query('who_renders', 'Exact'), /^# complete:/m);
});

test('component choices trace array elements, helper returns and fallback branches', { timeout: 40_000 }, async t => {
  const { build, query, root } = fixture(t, false, path.join(__dirname, 'fixtures/prop-flow'));
  const page = (name, source) => {
    const directory = path.join(root, 'app', name);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'page.tsx'), source);
  };
  for (const [route, render] of [
    ['nav-member', 'item => <item.icon/>'],
    ['nav-alias', 'item => { const Icon = item.icon; return <Icon/>; }'],
    ['nav-destructure', '({ href, icon: Icon }) => <a href={href}><Icon/></a>']
  ]) {
    page(route, `
      function HomeIcon() { return <span/>; }
      function LogIcon() { return <span/>; }
      const NAV = [{ href: '/dashboard', icon: HomeIcon }, { href: '/workout-log', icon: LogIcon }] as const;
      export default function Page() { return <nav>{NAV.map(${render})}</nav>; }
    `);
  }
  const nav = `
    function HomeIcon() { return <span/>; }
    function LogIcon() { return <span/>; }
  `;
  const navItems = `[{ href: '/dashboard', icon: HomeIcon }, { href: '/workout-log', icon: LogIcon }]`;
  fs.writeFileSync(path.join(root, 'app/react.d.ts'), 'declare namespace React { type ComponentType = () => any; }');
  const navChoices = [
    ['find-alias', 'const item = NAV.find(n => n.href === k)!; const Icon = item.icon; return <Icon/>;'],
    ['find-optional', 'const Icon = NAV.find(n => n.href === k)?.icon; return Icon ? <Icon/> : null;', true],
    ['filter-map', 'return <nav>{NAV.filter(n => n.href === k).map(item => <item.icon/>)}</nav>;'],
    ['find-tuple', 'const item = NAV.find(n => n.href === k); if (!item) return null; const Icon = item.icon; return <Icon/>;', true, true],
    ['find-member', 'const item = NAV.find(n => n.href === k); return item ? <item.icon/> : null;', true],
    ['array-destructure', 'const [first] = NAV; const Icon = first.icon; return <Icon/>;'],
    ['array-rest', 'const [, ...rest] = NAV; return <nav>{rest.map(item => <item.icon/>)}</nav>;'],
    ['find-last', 'const item = NAV.findLast(n => n.href === k)!; const Icon = item.icon; return <Icon/>;'],
    ['array-at', 'const Icon = NAV.at(0)!.icon; return <Icon/>;'],
    ['slice-chain', 'return <nav>{NAV.slice(0).toSorted().toReversed().sort().reverse().map(({ icon: Icon }) => <Icon/>)}</nav>;'],
    ['flat-map', 'return <nav>{NAV.flatMap(item => item).map(item => <item.icon/>)}</nav>;'],
    ['grouped-flat-map', 'return <nav>{GROUPS.flatMap(group => group.items).map(item => <item.icon/>)}</nav>;'],
    ['grouped-flat-find', 'const Icon = GROUPS.flatMap(group => group.items).find(n => n.href === k)?.icon; return Icon ? <Icon/> : null;', true],
    ['transformed-map', 'return <nav>{NAV.map(item => ({ ...item, active: true })).map(item => <item.icon/>)}</nav>;'],
    ['named-mapper', 'const select = ({ icon }) => ({ Icon: icon }); return <nav>{NAV.map(select).map(({ Icon }) => <Icon/>)}</nav>;'],
    ['array-from', 'return <nav>{Array.from(NAV).map(item => <item.icon/>)}</nav>;'],
    ['reduce-jsx', 'return <nav>{NAV.reduce((acc, item) => [...acc, <item.icon/>], [])}</nav>;'],
    ['state-destructure', 'const [items] = useNavState(NAV); return <nav>{items.map(item => <item.icon/>)}</nav>;'],
    ['state-index', 'return <nav>{useNavState(NAV)[0].map(item => <item.icon/>)}</nav>;'],
    ['typed-find', 'const Icon = NAV.find(n => n.href === k)!.icon; return <Icon/>;'],
    ['typed-filter', 'return <nav>{NAV.filter(n => n.href === k).map(item => <item.icon/>)}</nav>;'],
    ['concat-map', 'return <nav>{NAV.slice(0, 1).concat({ href: "/more", icon: ExtraIcon }).map(item => <item.icon/>)}</nav>;']
  ];
  for (const [route, render, , tuple] of navChoices) {
    page(route, nav + `
      ${route === 'concat-map' ? 'function ExtraIcon() { return <span/>; }' : ''}
      ${route.startsWith('state-') ? "import { useState as useNavState } from 'react';" : ''}
      type Item = { href: string; icon: React.ComponentType };
      const NAV${route.startsWith('typed-') ? ': Item[]' : ''} = ${navItems}${tuple ? ' as const' : ''};
      ${route.startsWith('grouped-') ? 'const GROUPS = [{ items: [{ href: "/dashboard", icon: HomeIcon }] }, { items: [{ href: "/workout-log", icon: LogIcon }] }];' : ''}
      export default function Page({ k }: { k: string }) { ${render} }
    `);
  }
  page('typed-map', nav + `
    type Item = { href: string; icon: React.ComponentType };
    const NAV: Item[] = ${navItems};
    export default function Page() { return <nav>{NAV.map(item => <item.icon/>)}</nav>; }
  `);
  page('typed-index', nav + `
    interface Item { href: string; icon: React.ComponentType }
    const NAV: Item[] = ${navItems};
    export default function Page() { const Icon = NAV[0].icon; return <Icon/>; }
  `);
  page('map-override', nav + `
    const NAV = [{ icon: HomeIcon }];
    export default function Page() { return <nav>{NAV.map(item => ({ ...item, icon: LogIcon })).map(item => <item.icon/>)}</nav>; }
  `);
  page('tuple-destructure', nav + `
    const NAV = ${navItems} as const;
    export default function Page() { const [, second] = NAV; return <second.icon/>; }
  `);
  page('property-fallback', nav + `
    function UnusedIcon() { return <span/>; }
    const NAV = [{ icon: HomeIcon, badge: UnusedIcon }, { icon: LogIcon, badge: UnusedIcon }] as const;
    declare function opaque<T>(value: T): T;
    export default function Page() { const Icon = opaque(NAV)[0].icon; return <Icon/>; }
  `);
  fs.writeFileSync(path.join(root, 'app/signal.ts'), "export function signal() { return 'ok'; }\n");
  fs.writeFileSync(path.join(root, 'app/impact-components.tsx'), `
    import { signal } from './signal';
    function Leaf() { return <span>{signal()}</span>; }
    function Middle() { return <Leaf/>; }
    export function Shared({ show }: { show: boolean }) { return <>{show ? <Leaf/> : null}<Middle/></>; }
  `);
  page('certain-impact', `
    import { Shared } from '../impact-components';
    export default function Page() { return <Shared show={true}/>; }
  `);
  const steps = `
    function StepA() { return <span/>; }
    function StepB() { return <span/>; }
  `;
  page('tuple-step', steps + `
    const STEPS = [StepA, StepB] as const;
    export default function Page({ i }: { i: number }) { const Step = STEPS[i]; return <Step/>; }
  `);
  page('list-step', steps + `
    const STEPS = [StepA, StepB];
    export default function Page({ i }: { i: number }) { const Step = STEPS[i]; return <Step/>; }
  `);
  page('fixed-step', steps + `
    const STEPS = [StepA, StepB] as const;
    const index = 1;
    export default function Page() { const Step = STEPS[index]; return <Step/>; }
  `);
  for (const [route, index] of [['tuple-at-first', '0'], ['tuple-at-last', '-1'], ['tuple-at-outside', '-3']]) {
    page(route, steps + `
      const STEPS = [StepA, StepB] as const;
      export default function Page() { const Step = STEPS.at(${index})!; return <Step/>; }
    `);
  }
  const icons = `
    function IconA() { return <span/>; }
    function IconB() { return <span/>; }
    const MAP = { a: IconA, b: IconB };
  `;
  for (const [route, render] of [
    ['object-values', 'Object.values(MAP).map(Icon => <Icon/>)'],
    ['object-entries', 'Object.entries(MAP).map(([key, Icon]) => <Icon key={key}/>)'],
    ['entry-alias', 'Object.entries(MAP).map(entry => { const Icon = entry[1]; return <Icon/>; })']
  ]) {
    page(route, icons + `export default function Page() { return <nav>{${render}}</nav>; }`);
  }
  page('and-choice', icons + `
    export default function Page({ flag }: { flag: boolean }) {
      const Icon = (flag && IconA) && IconB;
      return Icon ? <Icon/> : null;
    }
  `);
  page('helper-choice', icons + `
    function pick(k: keyof typeof MAP) { return MAP[k]; }
    export default function Page({ k }: { k: keyof typeof MAP }) { const Icon = pick(k); return <Icon/>; }
  `);
  page('ternary-choice', icons + `
    export default function Page({ show }: { show: boolean }) { const Icon = show ? IconA : IconB; return <Icon/>; }
  `);
  for (const [route, expression] of [['nullish-choice', 'MAP[k] ?? Fallback'], ['or-choice', 'MAP[k] || Fallback']]) {
    page(route, icons + `
      import { createElement } from 'react';
      function Fallback() { return <span/>; }
      export default function Page({ k }: { k: keyof typeof MAP }) {
        ${route === 'nullish-choice' ? `const Icon = ${expression}; return <Icon/>;` : `return createElement(${expression});`}
      }
    `);
  }
  build();
  const renders = (route, component) => query('who_renders', `app/${route}/page.tsx#${component}`);
  const possible = (route, component, condition = '') => {
    const output = renders(route, component);
    assert.match(output, new RegExp(`^/${route}\\s.*${condition}\\[possible\\]`, 'm'));
    assert.match(output, /^# partial: component lookup key untraced/m);
  };
  for (const route of ['nav-member', 'nav-alias', 'nav-destructure', 'typed-map']) {
    for (const component of ['HomeIcon', 'LogIcon']) await t.test(`${route} certainly renders ${component}`, () => {
      const output = renders(route, component);
      assert.match(output, new RegExp(`^/${route}\\s[^\\n]*depth 1$`, 'm'));
      assert.match(output, /^# complete:/m);
    });
  }
  for (const [route, , conditional] of navChoices) {
    await t.test(`${route} reports possible array elements`, () => {
      for (const component of ['HomeIcon', 'LogIcon', ...(route === 'concat-map' ? ['ExtraIcon'] : [])]) {
        possible(route, component, conditional ? '\\[cond\\] ' : '');
      }
    });
  }
  await t.test('fixed typed array indexing traces the selected property through the receiver', () => {
    assert.doesNotMatch(renders('typed-index', 'LogIcon'), /^\/typed-index\s/m);
    const output = renders('typed-index', 'HomeIcon');
    assert.match(output, /^\/typed-index\s[^\n]*depth 1$/m);
    assert.match(output, /^# complete:/m);
  });
  await t.test('map traces an overwritten property through its callback return', () => {
    assert.doesNotMatch(renders('map-override', 'HomeIcon'), /^\/map-override\s/m);
    possible('map-override', 'LogIcon');
  });
  await t.test('fixed tuple destructuring skips holes and resolves the selected element', () => {
    assert.doesNotMatch(renders('tuple-destructure', 'HomeIcon'), /^\/tuple-destructure\s/m);
    const output = renders('tuple-destructure', 'LogIcon');
    assert.match(output, /^\/tuple-destructure\s[^\n]*depth 1$/m);
    assert.match(output, /^# complete:/m);
  });
  await t.test('unresolved receiver falls back to the same property on sibling elements', () => {
    for (const component of ['HomeIcon', 'LogIcon']) possible('property-fallback', component);
    assert.doesNotMatch(renders('property-fallback', 'UnusedIcon'), /^\/property-fallback\s/m);
  });
  await t.test('impact picks the unconditional path through a shared component', () => {
    const output = query('impact', 'app/signal.ts#signal');
    assert.match(output, /^page \/certain-impact\s[^\n]*d4 via Shared > Middle$/m);
    assert.match(output, /^d2 render app\/impact-components\.tsx:\d+ Shared < Leaf \[cond\]$/m);
    assert.match(output, /^d3 render app\/impact-components\.tsx:\d+ Shared < Middle$/m);
    assert.match(output, /^d4 render app\/certain-impact\/page\.tsx:\d+ Page < Shared$/m);
    assert.match(output, /^# complete:/m);
  });
  for (const route of ['tuple-step', 'list-step', 'helper-choice', 'object-values', 'object-entries', 'entry-alias']) {
    const components = route.endsWith('-step') ? ['StepA', 'StepB'] : ['IconA', 'IconB'];
    for (const component of components) await t.test(`${route} renders ${component}`, () => possible(route, component));
  }
  await t.test('logical AND only renders its right operand and marks it conditional', () => {
    assert.doesNotMatch(renders('and-choice', 'IconA'), /^\/and-choice\s/m);
    const output = renders('and-choice', 'IconB');
    assert.match(output, /^\/and-choice\s.*\[cond\]$/m);
    assert.match(output, /^# complete:/m);
  });
  await t.test('a fixed index resolves exactly one tuple element', () => {
    assert.doesNotMatch(renders('fixed-step', 'StepA'), /^\/fixed-step\s/m);
    const output = renders('fixed-step', 'StepB');
    assert.match(output, /^\/fixed-step\s[^\n]*depth 1$/m);
    assert.match(output, /^# complete:/m);
  });
  await t.test('tuple at resolves exact positive and negative positions and omits out-of-range values', () => {
    for (const [route, selected, other] of [['tuple-at-first', 'StepA', 'StepB'], ['tuple-at-last', 'StepB', 'StepA']]) {
      const output = renders(route, selected);
      assert.match(output, new RegExp(`^/${route}\\s[^\\n]*depth 1$`, 'm'));
      assert.match(output, /^# complete:/m);
      assert.doesNotMatch(renders(route, other), new RegExp(`^/${route}\\s`, 'm'));
    }
    for (const component of ['StepA', 'StepB']) {
      const output = renders('tuple-at-outside', component);
      assert.doesNotMatch(output, /^\/tuple-at-outside\s/m);
      assert.match(output, /^# complete:/m);
    }
  });
  for (const component of ['IconA', 'IconB']) await t.test(`the ternary conditionally renders ${component}`, () => {
    const output = renders('ternary-choice', component);
    assert.match(output, /^\/ternary-choice\s.*\[cond\]$/m);
    assert.match(output, /^# complete:/m);
  });
  for (const route of ['nullish-choice', 'or-choice']) {
    for (const component of ['IconA', 'IconB']) {
      await t.test(`${route} conditionally renders ${component}`, () => possible(route, component, '\\[cond\\] '));
    }
    await t.test(`${route} conditionally renders its fallback`, () => {
      const output = renders(route, 'Fallback');
      assert.match(output, new RegExp(`^/${route}\\s.*\\[cond\\]$`, 'm'));
      assert.match(output, /^# complete:/m);
    });
  }
});

test('an unresolved typed render lookup only affects components used as values', t => {
  const { build, query, root } = fixture(t, false, path.join(__dirname, 'fixtures/prop-flow'));
  fs.writeFileSync(path.join(root, 'ui/unused.tsx'), `
    import { memo } from 'react';
    export function UnusedIcon() { return <span/>; }
    export function StoredIcon() { return <span/>; }
    export function JsxOnlyIcon() { return <span/>; }
    export function WrappedIcon() { return <span/>; }
    export const MemoIcon = memo(WrappedIcon);
    export function RenderedInner() { return <span/>; }
    export const RenderedMemo = memo(RenderedInner);
    export const icons = [{ icon: StoredIcon }];
    export function Unmounted() { return <JsxOnlyIcon/>; }
  `);
  const other = path.join(root, 'app/other');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'page.tsx'), `
    import { RenderedMemo } from '../../ui/unused';
    export default function OtherPage() { return <RenderedMemo/>; }
  `);
  fs.writeFileSync(path.join(root, 'app/page.tsx'), `
    import OtherPage from './other/page';
    type Item = { icon: () => any };
    declare function loadNav(entry: () => any): Item[];
    const NAV = loadNav(OtherPage);
    export default function Page() { return <nav>{NAV.map(item => <item.icon/>)}</nav>; }
  `);
  build();
  for (const [tool, target] of [
    ['who_renders', 'StoredIcon'], ['callees', 'app/page.tsx#Page']
  ]) {
    const output = query(tool, target);
    assert.match(output, /^# partial: component lookup key untraced \(app\/page\.tsx:\d+\)/m);
    assert.doesNotMatch(output, /^(?:page )?\/\s/m);
  }
  for (const target of ['UnusedIcon', 'JsxOnlyIcon', 'WrappedIcon', 'MemoIcon', 'app/other/page.tsx#OtherPage']) {
    assert.match(query('who_renders', target), /^# complete:/m);
  }
  for (const target of ['UnusedIcon', 'JsxOnlyIcon']) assert.match(query('impact', target), /^# complete:/m);
  const inner = query('who_renders', 'RenderedInner');
  assert.match(inner, /^\/other\s.*depth 2 via RenderedMemo$/m);
  assert.match(inner, /^# complete:/m);
});

test('typed render collections of uninstalled package icons resolve externally', t => {
  const { build, query, root } = fixture(t, false, path.join(__dirname, 'fixtures/prop-flow'));
  fs.writeFileSync(path.join(root, 'app/page.tsx'), `
    import { BellIcon, ClockIcon } from 'iconpkg';
    function StoredIcon() { return <span/>; }
    export const stored = [StoredIcon];
    const OPTS: { value: string; icon: typeof BellIcon }[] = [
      { value: 'a', icon: BellIcon }, { value: 'b', icon: ClockIcon }
    ];
    export default function Page() {
      return <div>{OPTS.map(o => { const Icon = o.icon; return <Icon key={o.value}/>; })}</div>;
    }
  `);
  build();
  assert.match(query('callees', 'app/page.tsx#Page'), /^# complete:/m);
  assert.match(query('who_renders', 'StoredIcon'), /^# complete:/m);

  const file = path.join(root, 'app/page.tsx');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8')
    .replace('const OPTS', 'declare function loadIcon(): typeof BellIcon;\n    const OPTS')
    .replace('icon: ClockIcon', 'icon: loadIcon()'));
  build();
  assert.match(query('callees', 'app/page.tsx#Page'), /^# partial: component lookup key untraced/m);
  assert.match(query('who_renders', 'StoredIcon'), /^# partial: component lookup key untraced/m);
});

test('typed recursive collection properties trace nested icons', t => {
  const { build, query, root } = fixture(t, false, path.join(__dirname, 'fixtures/prop-flow'));
  const config = path.join(root, 'tsconfig.json');
  const settings = JSON.parse(fs.readFileSync(config, 'utf8'));
  settings.compilerOptions.strict = true;
  fs.writeFileSync(config, JSON.stringify(settings));
  fs.writeFileSync(path.join(root, 'app/page.tsx'), `
    function A() { return <span/>; }
    function B() { return <span/>; }
    function C() { return <span/>; }
    type Item = { id: string; icon: () => any; children?: Item[] };
    const NAV: Item[] = [{ id: 'a', icon: A, children: [{ id: 'c', icon: C }] }, { id: 'b', icon: B }];
    export default function Page() {
      return <nav>{NAV.map(n => <><n.icon/>{n.children?.map(c => <c.icon/>)}</>)}</nav>;
    }
  `);
  build();
  for (const icon of ['A', 'B', 'C']) {
    const output = query('who_renders', 'app/page.tsx#' + icon);
    assert.match(output, /^\/\s+app\/page\.tsx:\d+\s+depth 1/m);
    assert.match(output, /^# complete:/m);
  }
});

test('typed collection props resolve consts and object members at their supplying JSX sites', t => {
  const { build, query, root } = fixture(t, false, path.join(__dirname, 'fixtures/prop-flow'));
  fs.writeFileSync(path.join(root, 'ui/nav-main.tsx'), `
    export function NavMain({ items }: { items: { title: string; icon: () => any }[] }) {
      return <nav>{items.map(item => item.icon && <item.icon/>)}</nav>;
    }
    export function NavRow({ item }: { item: { title: string; icon: () => any } }) {
      return <item.icon/>;
    }
    export function Ignore({ body }: { body: any }) { return <aside/>; }
  `);
  for (const [route, icon, value] of [['object-nav', 'ObjectIcon', 'data.navMain'], ['const-nav', 'ConstIcon', 'items']]) {
    fs.mkdirSync(path.join(root, 'app', route));
    fs.writeFileSync(path.join(root, 'app', route, 'page.tsx'), `
      import { NavMain } from '../../ui/nav-main';
      function ${icon}() { return <span/>; }
      const items = [{ title: 'a', icon: ${icon} }];
      const data = { navMain: items };
      export default function Page() { return <NavMain items={${value}}/>; }
    `);
  }
  fs.writeFileSync(path.join(root, 'app/page.tsx'), `
    import { BellIcon } from 'iconpkg';
    import { NavRow, NavMain, Ignore } from '../ui/nav-main';
    function HiddenIcon() { return <span/>; }
    const rows: { title: string; icon: typeof BellIcon }[] = [{ title: 'a', icon: BellIcon }];
    const hidden = [{ title: 'b', icon: HiddenIcon }];
    export default function Page() {
      return <>{rows.map(item => <NavRow item={item}/>)}<Ignore body={<NavMain items={hidden}/>}/></>;
    }
  `);
  build();
  for (const [route, icon, other] of [['object-nav', 'ObjectIcon', 'const-nav'], ['const-nav', 'ConstIcon', 'object-nav']]) {
    const output = query('who_renders', icon);
    assert.match(output, new RegExp(`^/${route}\\s.*\\[cond\\]`, 'm'));
    assert.doesNotMatch(output, new RegExp(`^/${other}\\s`, 'm'));
    assert.match(output, /^# complete:/m);
    assert.match(query('impact', icon), new RegExp(`^page /${route}\\s`, 'm'));
    assert.doesNotMatch(query('impact', icon), new RegExp(`^page /${other}\\s`, 'm'));
  }
  assert.match(query('callees', 'NavRow'), /^# complete:/m);
  assert.match(query('who_renders', 'HiddenIcon'), /0 results.*\n# complete:/m);
});

test('shortening who_renders route annotations preserves completeness and route flags', t => {
  const { build, query, root } = fixture(t, false, path.join(__dirname, 'fixtures/prop-flow'));
  const wrapper = 'Wrapper' + 'LongDisplayName'.repeat(25);
  fs.writeFileSync(path.join(root, 'app/page.tsx'), `
    function ${wrapper}({ children }: { children: any }) { return <div>{children}</div>; }
    function LongRouteIcon() { return <span/>; }
    export default function Page() {
      return Math.random() ? <${wrapper}><LongRouteIcon/></${wrapper}> : null;
    }
  `);
  build();
  const output = query('who_renders', 'LongRouteIcon');
  const route = output.split('\n').find(line => /^\/\s/.test(line));
  assert.match(route, /^\/\s+app\/page\.tsx:\d+\s+depth 1.*\.\.\..*\[cond\]$/);
  assert.ok(Buffer.byteLength(route) <= 400);
  assert.match(output, /^# complete:/m);
});

test('Pages routes resolve shell composition, data, middleware, navigation and API evidence', async t => {
  const { build, query, env, root } = fixture(t, false, path.join(__dirname, 'fixtures/pages-router'));
  const index = JSON.parse(fs.readFileSync(build(), 'utf8'));
  const wrappers = query('wrappers', '/base/ko/posts/article?preview=true');
  assert.match(wrappers, /document pages\/_document.page.tsx:3 HtmlDocument \[server; Main at pages\/_document.page.tsx:5\]/);
  assert.match(wrappers, /_app.page.tsx:12 translate, App/);
  assert.match(wrappers, /providers \(outermost first\): OuterProvider, LayoutProvider/);
  assert.match(wrappers, /LayoutProvider \[getLayout at lib\/shells.tsx:6; assigned at pages\/posts\/\[slug\].page.tsx:8\]/);
  assert.doesNotMatch(wrappers, /PageBodyProvider|Never|Maintenance|PropertyWrapper/);
  assert.match(query('wrappers', '/posts/new'), /PropertyWrapper \[PageWrapper assigned at pages\/posts\/new.page.tsx:5\]/);
  assert.doesNotMatch(query('wrappers', '/modern'), /Document|OuterProvider/);
  assert.match(query('wrappers', 'pages/_document.page.tsx'), /custom shell applies to Pages routes/);
  assert.equal(query('wrappers', '/guide'), query('wrappers', '/guide/one/two'));
  assert.match(query('who_renders', 'LayoutProvider'), /\/posts\/\[slug\]/);
  assert.match(query('who_renders', 'PropertyWrapper'), /\/posts\/new/);
  assert.match(query('path', '/posts/one', 'loadArticle'), /1 data .*getStaticProps · build\/revalidation\)\n2 call .*loadArticle/);
  assert.match(query('path', '/posts/one', 'findArticles'), /getStaticPaths · build\/enumeration/);
  assert.match(query('callees', '/posts/new', '--depth', '2'), /getInitialProps · page initial request\/client transition/);
  assert.match(query('callees', '/posts/new', '--depth', '2'), /getInitialProps · Document server render/);
  const lifecycle = query('callees', 'pages/posts/new.page.tsx#getServerSideProps');
  assert.match(lifecycle, /d1 call .*loadUser/);
  assert.doesNotMatch(lifecycle, /loadUnrelated/);
  assert.match(query('impact', 'loadArticle'), /page \/posts\/\[slug\]/);
  assert.match(query('path', '/opaque', 'loadUser'), /# partial:.*callback invocation/);
  assert.match(query('path', '/posts/new', 'middleware'), /1 middleware middleware.ts:9 middleware/);
  assert.match(query('path', '/api/auth/signup', 'middleware'), /1 middleware middleware.ts:10 middleware/);
  assert.match(query('path', '/guide', 'middleware'), /# partial: possible middleware edge/);
  assert.match(query('path', '/excluded', 'middleware'), /no directed path/);
  assert.match(query('impact', 'middleware'), /3 exact, 2 possible Pages routes/);
  assert.match(query('path', '/redirect', '/target'), /1 redirect next.config.js:6 \/target/);
  assert.match(query('path', '/', '/guide/testing'), /navigate pages\/index.page.tsx:7 .*as \/displayed/);
  assert.match(query('path', '/', '/target'), /navigate pages\/index.page.tsx:13/);
  assert.match(query('path', '/', '/excluded'), /# partial: dynamic client navigation destination/);
  assert.doesNotMatch(query('impact', 'TargetBody'), /page \/  /);
  assert.doesNotMatch(query('who_renders', 'TargetBody'), /^\/  /m);
  assert.match(query('search', '/base/ko/posts/article'), /pages\/posts\/\[slug\].page.tsx/);

  const route = file => index.routes.find(route => route.file === file);
  assert.deepEqual(route('pages/api/auth/signup.page.ts').methods, ['POST']);
  assert.deepEqual(route('pages/api/table.page.ts').methods, ['POST']);
  assert.equal(route('pages/api/table.page.ts').methodBasis, 'enforced');
  assert.ok(!index.routes.some(route => /verification.test|unrelated|ignored/.test(route.file)));
  assert.match(query('api_consumers', '/api/table'), /POST axios .*HTTP client at lib\/requests.ts:6/);
  const api = query('api_consumers', '/base/api/auth/token');
  assert.match(api, /GET Playwright request \[test\]/);
  assert.match(api, /request.spec.ts:9 csrf GET Playwright request/);
  assert.match(api, /GET tRPC request/);
  assert.match(api, /POST tRPC request/);
  assert.doesNotMatch(api, /POST fetch|POST Playwright request/);
  assert.match(query('api_consumers', '/api/auth/signup'), /POST fetch/);
  assert.match(query('api_consumers', '/api/auth/signup'), /POST Playwright request/);
  assert.doesNotMatch(query('api_consumers', '/api/auth'), /send /);
  assert.match(query('api_consumers', '/api/auth/shadow'), /mention .*route literal/);

  const mcp = await openMcp(t, root, { command: process.execPath, args: [entry, 'mcp'], cwd: root, env });
  assert.equal(await mcp.text('query', { kind: 'wrappers', target: '/base/ko/posts/article?preview=true' }), wrappers);

  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.email=fixture@example.test', '-c', 'user.name=Fixture', 'commit', '-qm', 'Fixture');
  const edit = (file, before, after) => {
    const target = path.join(root, file);
    fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace(before, after));
  };
  edit('lib/data.ts', "return 'article'", "return 'changed'");
  edit('middleware.ts', "'/target'", "'/target?changed=1'");
  build();
  const changes = query('changes');
  assert.match(changes, /route page \/posts\/\[slug\].*loadArticle/);
  assert.match(changes, /route page \/guide\/\[\[\.\.\.steps\]\].*middleware d1 \[possible\]/);
  assert.doesNotMatch(changes, /route page \/excluded|route page \/target/);
});

test('Pages API workspace proof is scoped and invalidates the index after sibling changes', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'neorion-pages-workspace-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const workspace = path.join(temporary, 'workspace');
  fs.cpSync(path.join(__dirname, 'fixtures/pages-router-workspace'), workspace, { recursive: true });
  const cwd = path.join(workspace, 'web');
  const cache = path.join(temporary, 'cache');
  const env = { ...process.env, XDG_CACHE_HOME: cache, LOCALAPPDATA: cache, NEORION_AUTOBUILD: '1' };
  const run = (...args) => {
    const result = spawnSync(process.execPath, [entry, ...args], { cwd, env, encoding: 'utf8', timeout: cliSpawnTimeout });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const overview = /^Overview: (.+)$/m.exec(run('graph'))[1];
  const indexFile = path.join(path.dirname(overview), indexPath);
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  assert.deepEqual(index.routes.find(route => route.url === '/api/fixture').methods, ['POST']);
  assert.deepEqual(index.routes.find(route => route.url === '/api/alias').methods, ['ALL']);
  assert.equal(index.workspacePackages['../packages/dispatch/handler.ts'], '@fixture/dispatch');
  assert.ok(!Object.keys(index.files).some(file => file.includes('/packages/unused/')));
  fs.writeFileSync(path.join(workspace, 'packages/dispatch/handler.ts'), 'export const dispatch = () => () => null;\n');
  const query = run('query', 'api_consumers', '/api/fixture');
  assert.match(query, /# partial: API handler factory or re-export unresolved/);
  assert.deepEqual(JSON.parse(fs.readFileSync(indexFile, 'utf8')).routes.find(route => route.url === '/api/fixture').methods, ['ALL']);
});

function pagesReviewFixture(t, files) {
  const { root, build, query } = fixture(t, false, path.join(__dirname, 'fixtures/pages-router'));
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  build();
  return query;
}

test('Pages wrapper predicates use the effective page properties', t => {
  const query = pagesReviewFixture(t, {
    'pages/_app.page.tsx': `
      export default function App(props) {
        const { Component, pageProps } = props;
        return Component.PageWrapper ? <Component.PageWrapper {...props} /> : <Component {...pageProps} />;
      }`,
    'lib/license.tsx': `
      export function LicenseRequired({ children }) { return <section>{children}</section>; }
      export function PageWrapper({ Component: Screen, pageProps }) {
        const requiresLicense = Screen.requiresLicense;
        return requiresLicense ? <LicenseRequired><Screen {...pageProps} /></LicenseRequired> : <Screen {...pageProps} />;
      }`,
    'pages/index.page.tsx': `
      import { PageWrapper } from '../lib/license';
      export default function Home() { return <div />; }
      Home.PageWrapper = PageWrapper;`,
    'pages/licensed.page.tsx': `
      import { PageWrapper } from '../lib/license';
      export default function Licensed() { return <div />; }
      Licensed.PageWrapper = PageWrapper;
      Licensed.requiresLicense = true;`,
    'pages/unknown-license.page.tsx': `
      import { PageWrapper } from '../lib/license';
      export default function UnknownLicense() { return <div />; }
      UnknownLicense.PageWrapper = PageWrapper;
      UnknownLicense.requiresLicense = process.env.REQUIRES_LICENSE === '1';`
  });
  const home = query('wrappers', '/');
  assert.match(home, /PageWrapper assigned at/);
  assert.doesNotMatch(home, /LicenseRequired/);
  assert.match(home, /# complete:/);
  const renders = query('who_renders', 'LicenseRequired');
  assert.doesNotMatch(renders, /^\/  /m);
  assert.match(renders, /^\/licensed  .*\n/m);
  assert.match(renders, /^\/unknown-license  .*\[possible\]/m);
  assert.match(renders, /# partial:.*requiresLicense/);
  assert.match(query('path', '/', 'lib/license.tsx#LicenseRequired'), /# complete: no directed path/);
  assert.match(query('path', '/licensed', 'LicenseRequired'), /1 render .*LicenseRequired/);
  assert.doesNotMatch(query('callees', '/', '--depth', '2'), /LicenseRequired/);
  const impact = query('impact', 'LicenseRequired');
  assert.doesNotMatch(impact, /^page \/  /m);
  assert.match(impact, /^page \/licensed  /m);
  const unknown = query('path', '/unknown-license', 'LicenseRequired');
  assert.match(unknown, /1 render .*\[possible\]/);
  assert.match(unknown, /# partial:.*requiresLicense/);
  assert.match(query('wrappers', '/unknown-license'), /LicenseRequired.*\[possible\]/);
});

test('Pages lifecycle callbacks need reachable invocation or forwarding', t => {
  const query = pagesReviewFixture(t, {
    'pages/ghost.page.tsx': `
      export default function Ghost() { return <div />; }
      function wrap(callback) {
        return () => {
          const neverCalled = () => callback();
          return { props: {} };
          callback();
        };
      }
      export const getServerSideProps = wrap(() => unreachable());
      function unreachable() {}`,
    'pages/forwarded.page.tsx': `
      export default function Forwarded() { return <div />; }
      const makeHandler = callback => () => callback();
      function wrap(callback) {
        const run = () => callback();
        return makeHandler(run);
      }
      export const getServerSideProps = wrap(() => reachable());
      function reachable() {}`,
    'pages/uncertain.page.tsx': `
      import { run } from 'opaque-runner';
      export default function Uncertain() { return <div />; }
      function wrap(callback) {
        return () => run(callback);
      }
      export const getServerSideProps = wrap(() => uncertain());
      function uncertain() {}`
  });
  assert.match(query('path', '/ghost', 'unreachable'), /# complete: no directed path/);
  assert.doesNotMatch(query('callees', 'pages/ghost.page.tsx#getServerSideProps'), /unreachable/);
  assert.match(query('path', '/forwarded', 'reachable'), /2 call .*reachable/);
  const uncertain = query('path', '/uncertain', 'uncertain');
  assert.match(uncertain, /2 call .*uncertain.*\[possible\]/);
  assert.match(uncertain, /# partial:.*callback invocation/);
});

test('Pages API methods follow unconditional rejection and Pages handlers receive HEAD as sent', t => {
  const query = pagesReviewFixture(t, {
    'pages/index.page.tsx': `
      export default function Home() { return <div />; }
      export function readStatus() { return fetch('/api/status'); }
      export function sendHead() { return fetch('/api/read-only', { method: 'HEAD' }); }
      export function appHead() { return fetch('/api/app-read', { method: 'HEAD' }); }
      export function sendPost() { return fetch('/api/oidc', { method: 'POST' }); }
      export function readDynamic() { return fetch('/api/runtime-method'); }`,
    'pages/api/status.page.ts': `
      export default function handler(req, res) {
        if (req.method === 'POST' && !req.body) return res.status(405).end();
        return res.status(200).end();
      }`,
    'pages/api/oidc.page.ts': `
      export default function handler(req, res) {
        if (req.method !== 'GET') return res.status(400).send('Method not allowed');
        return res.status(200).end();
      }`,
    'pages/api/read-only.page.ts': `
      export default function handler(req, res) {
        if (req.method !== 'GET') return res.status(405).end();
        return res.status(200).end();
      }`,
    'pages/api/runtime-method.page.ts': `
      export default function handler(req, res) {
        if (isAllowed(req.method)) return res.status(200).end();
        return res.status(405).end();
      }`,
    'app/api/app-read/route.ts': 'export function GET() { return new Response(null); }'
  });
  const status = query('api_consumers', '/api/status');
  assert.match(status, /GET fetch/);
  assert.doesNotMatch(status, /methods enforced/);
  assert.match(query('path', 'readStatus', '/api/status'), /1 fetch .*GET \/api\/status/);
  assert.match(query('api_consumers', '/api/oidc'), /# methods enforced: GET/);
  assert.match(query('path', 'sendPost', '/api/oidc'), /# complete: no directed path/);
  assert.match(query('path', 'sendHead', '/api/read-only'), /# complete: no directed path/);
  const runtimeMethod = query('path', 'readDynamic', '/api/runtime-method');
  assert.match(runtimeMethod, /1 fetch .*\[possible\]/);
  assert.match(runtimeMethod, /# partial: Pages API method enforcement unresolved/);
  assert.match(query('path', 'appHead', '/api/app-read'), /1 fetch .*HEAD \/api\/app-read/);
});

test('Pages middleware paths check concrete catch-all URLs against the matcher', t => {
  const { build, query } = fixture(t, false, path.join(__dirname, 'fixtures/pages-router'));
  build();
  assert.match(query('path', '/base/api/auth/csrf?check=1', 'middleware'), /no directed path/);
  assert.match(query('path', '/api/auth/[...parts]', 'middleware'), /1 middleware .*\[possible\]/);
  assert.match(query('path', '/base/api/auth/csrf/embed?check=1', 'middleware'), /1 middleware .*\/:path\*\/embed/);
  assert.doesNotMatch(query('path', '/api/auth/csrf/embed', 'middleware'), /\[possible\]/);
});

test('queries preserve MDX layouts, conditional list renders, callbacks, and HTTP and literal evidence', { timeout: 40_000 }, t => {
  const source = path.join(__dirname, 'fixtures/agent-evidence');
  const { build, query } = fixture(t, false, source);
  const indexFile = build();
  const { packGraph } = loadAnalyzer('../../mcp/GraphStorage');
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  fs.writeFileSync(indexFile, JSON.stringify(packGraph(index, 0)));

  const wrappers = query('wrappers', '/guide');
  assert.match(wrappers, /page app\/guide\/page.mdx:1/);
  assert.match(wrappers, /# providers .*ThemeProvider/);
  assert.doesNotMatch(wrappers, /# providers .*LoggingProvider/);
  assert.match(wrappers, /# partial: MDX page body and imports untraced/);

  const renders = query('who_renders', 'ResourceRow', '--direct');
  assert.match(renders, /app\/page\.tsx:7#Page .*when .*enabled.*ready.*useAlternate/);
  assert.match(renders, /ui\/panel\.tsx:33#ResourcePanel .*when .*items\.length > 0.*item\.visible.*list items\.map/);
  const impact = query('impact', 'ResourceRow');
  assert.match(impact, /render ui\/panel\.tsx:33 ResourceRow .*list items\.map/);

  const callbacks = query('api_consumers', 'sendResource');
  assert.match(callbacks, /onChange <input> -> select/);
  assert.match(callbacks, /onChange <input> -> markdownPick/);
  assert.match(callbacks, /select -> send \(prop onPick/);
  assert.match(callbacks, /page \/ /);

  const status = query('callees', 'chooseStatus');
  assert.match(status, /return router\.ts:6 \{status: "pending_review", title \(parameter\)\}/);
  assert.match(status, /return router\.ts:7 \{status: "live", title \(parameter\)\}/);
  const submit = query('callees', 'ResourcePanel', '--depth', '3', '--limit', '60');
  assert.match(submit, /submit .*\[args true\]/);
  assert.match(submit, /resources\.store .*kind: "RESOURCE"/);
  assert.doesNotMatch(submit, /should-stay-private/);
  const refresh = query('callees', 'refreshResources');
  assert.match(refresh, /chooseStatus .*\[args false, \[redacted string\]\]/);
  assert.doesNotMatch(refresh, /"Refresh"/);
  assert.match(submit, /POST \/api\/dispatch\/\[procedure\]/);
  const trpc = query('api_consumers', '/api/dispatch/[procedure]');
  assert.match(trpc, /POST tRPC request \(resources\.store via ui\/rpc\.ts:\d+, ui\/rpc\.ts:\d+/);

  const consumers = query('api_consumers', '/services/refresh');
  assert.match(consumers, /worker\/tasks\.ts:6 runTasks POST fetch/);
  assert.match(consumers, /worker\/tasks\.ts:7 runTasks POST Node HTTP request/);
  assert.doesNotMatch(consumers, /ignoreLiteral|externalRequest/);
  assert.match(consumers, /2 sites in 1 file: 2 requests/);
  assert.match(consumers, /# partial: .*deployment trigger untraced/);
  assert.match(query('impact', 'refreshResources'), /fetch worker\/tasks\.ts:6 POST \/services\/refresh/);
});

test('excluded JS requests are isolated, bounded by source directories, and scoped to plausible routes', t => {
  const source = path.join(__dirname, 'fixtures/agent-evidence');
  const { build, query, root } = fixture(t, false, source);
  const write = (file, text) => {
    const location = path.join(root, file);
    fs.mkdirSync(path.dirname(location), { recursive: true });
    fs.writeFileSync(location, text);
  };
  write('scripts/check.mjs', `
    import { request as httpsRequest } from 'node:https';
    export function check() {
      httpsRequest('/services/refresh', { method: 'POST' });
      fetch('https://example.test/api/dispatch/store', { method: 'POST' });
    }
  `);
  const generated = ['node_modules', 'dist', 'cdk.out', '.vercel', '.turbo', '.output', '.sst', '.open-next'];
  for (const directory of generated) {
    write(`scripts/nested/${directory}/generated.ts`, "export const ignored = () => fetch('/services/refresh');");
  }
  write('app/[code]/route.ts', 'export const GET = () => Response.json({});');
  write('app/feed.xml/route.ts', 'export const GET = () => Response.json({});');
  write('scripts/foreign.mjs', `
    fetch('https://ipapi.co/json');
    fetch('https://blog.example.com/feed.xml');
  `);
  const index = JSON.parse(fs.readFileSync(build(), 'utf8'));
  assert.ok(!Object.keys(index.files).some(file => file.startsWith('scripts/') || file.startsWith('worker/')));
  assert.ok(index.symbols.every(symbol => symbol.name !== 'check' && symbol.name !== 'ignored'));
  const refresh = query('api_consumers', '/services/refresh');
  assert.match(refresh, /scripts\/check\.mjs:4 check POST Node HTTP request/);
  assert.doesNotMatch(refresh, /generated\.ts|foreign\.mjs/);
  const dispatch = query('api_consumers', '/api/dispatch/[procedure]');
  assert.match(dispatch, /^# partial: .*deployment trigger untraced/m);
  assert.match(dispatch, /^# partial: .*uncertain URL matches/m);
  for (const route of ['/[code]', '/feed.xml']) {
    assert.doesNotMatch(query('api_consumers', route), /scripts\/foreign\.mjs/);
  }
});

test('splitLink preserves certain procedure calls when HTTP dispatch is unresolved', t => {
  const source = path.join(__dirname, 'fixtures/agent-evidence');
  const { build, query, root } = fixture(t, false, source);
  const rpc = path.join(root, 'ui/rpc.ts');
  fs.writeFileSync(rpc, fs.readFileSync(rpc, 'utf8').replace('false: httpLink({ url: rpcUrl() })', "false: httpLink({ url: '/other' })"));
  build();
  const consumers = query('api_consumers', 'resources.store');
  assert.match(consumers, /# complete: indexed tRPC callers/);
  assert.match(consumers, /tRPC HTTP handler or client dispatch unresolved/);
  const impact = query('impact', 'resources.store');
  assert.doesNotMatch(impact, /# partial: [^\n]*tRPC HTTP handler or client dispatch unresolved|d1 [^\n]*\[possible\]/);
  assert.match(impact, /tRPC HTTP handler or client dispatch unresolved/);
  const pathResult = query('path', 'submit', 'resources.store');
  assert.match(pathResult, /trpc [^\n]*tRPC HTTP handler or client dispatch unresolved/);
  assert.doesNotMatch(pathResult, /# partial: [^\n]*tRPC HTTP handler or client dispatch unresolved|trpc [^\n]*\[possible\]/);
  const dispatch = query('api_consumers', '/api/dispatch/[procedure]');
  assert.match(dispatch, /# partial: .*tRPC HTTP handler or client dispatch unresolved/);
  assert.doesNotMatch(dispatch, /POST tRPC request/);
});

test('render queries trace else-if exits, flag complex early exits and summarize list receivers', t => {
  const source = path.join(__dirname, 'fixtures/agent-evidence');
  const { build, query, root } = fixture(t, false, source);
  fs.writeFileSync(path.join(root, 'app/page.tsx'), `
    import { ResourceRow } from '../ui/panel';
    export default function Page({ loading, error, items, count, work }) {
      if (loading) return null;
      else if (error) return null;
      switch (count) { case 0: return null; }
      for (const item of items) { if (item.hide) return null; }
      try { if (work()) return null; } catch {}
      return items.flatMap(item => item.visible ? [item] : []).map(item => <ResourceRow />);
    }
  `);
  fs.writeFileSync(path.join(root, 'app/layout.tsx'), `
    import { notFound as missing } from 'next/navigation';
    import { ThemeProvider, LocaleProvider } from 'widgets';
    export default function Layout({ children, supported }) {
      if (!supported) missing();
      return <ThemeProvider><LocaleProvider>{children}</LocaleProvider></ThemeProvider>;
    }
  `);
  fs.mkdirSync(path.join(root, 'app/long-guard'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app/long-guard/page.tsx'), `
    export function LongGuardChild() { return <i />; }
    export default function LongGuardParent({ flags }) {
      ${Array.from({ length: 5 }, (_, i) =>
        `if (${Array.from({ length: 15 }, (_, j) => `flags.flag${i}_${j}`).join(' || ')}) return null;`).join('\n')}
      return <LongGuardChild />;
    }
  `);
  build();
  const direct = query('who_renders', 'ResourceRow', '--direct');
  assert.match(direct, /app\/page\.tsx:9#Page .*when .*loading.*error.*list items\.flatMap\(\.\.\.\)\.map/);
  assert.match(direct, /\[guard partial: preceding switch, exception or loop exits untraced\]/);
  assert.match(direct, /^# complete:/m);
  const impact = query('impact', 'ResourceRow');
  assert.match(impact, /render app\/page\.tsx:9 ResourceRow .*\[guard partial:/);
  assert.match(impact, /^page \/ .*\[cond\]$/m);
  assert.doesNotMatch(impact, /app\/page\.tsx.*\[(?:possible|partial url)\]/);
  assert.doesNotMatch(impact, /# partial: .*exits untraced/);
  assert.doesNotMatch(direct, /item => item\.visible/);
  const longGuard = query('who_renders', 'LongGuardChild', '--direct');
  assert.match(longGuard, /^direct .*LongGuardParent .*\[when .*\.\.\./m);
  assert.match(longGuard, /^# complete:/m);
  assert.doesNotMatch(longGuard, /guard partial|output truncated/);
  const wrappers = query('wrappers', '/');
  assert.equal((wrappers.match(/\[when supported\]/g) ?? []).length, 1);
  assert.doesNotMatch(wrappers, /app\/layout\.tsx.*\[cond\]/);
});

test('impact budgets evidence independently of graph rows', t => {
  const { build, query, root } = fixture(t);
  fs.mkdirSync(path.join(root, 'app/budget'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app/budget/page.tsx'), `
    import { BudgetGroup } from './group';
    export default function BudgetPage() { return <BudgetGroup />; }
  `);
  fs.writeFileSync(path.join(root, 'app/budget/group.tsx'), `
    import { BudgetLeaf } from './leaf';
    export function BudgetGroup({ flags }) {
      return <>{${Array.from({ length: 80 }, (_, i) => `(flags.active && flags.visible && flags.ready && flags.item${i}) && <BudgetLeaf />`).join('}{')}} </>;
    }
  `);
  fs.writeFileSync(path.join(root, 'app/budget/leaf.tsx'), 'export function BudgetLeaf() { return <i />; }');
  build();
  const output = query('impact', 'BudgetLeaf');
  assert.match(output, /^d1 render app\/budget\/group\.tsx:.*BudgetGroup/m);
  assert.match(output, /^d2 render app\/budget\/page\.tsx:.*BudgetPage/m);
  assert.match(output, /^  render app\/budget\/group\.tsx:.*\[when /m);
  assert.match(output, /^# evidence lines omitted: [1-9]\d*$/m);
  assert.match(output, /^# complete:/m);
  assert.doesNotMatch(output, /^# more:/m);
  const limited = query('impact', 'BudgetLeaf', '--limit', '2');
  assert.match(limited, /^# more: 1 /m);
  assert.match(limited, /^# partial: output truncated/m);
});

test('impact retains callers beyond resolved in-file callback hops', t => {
  const { build, query, root } = fixture(t);
  fs.mkdirSync(path.join(root, 'app/callback-budget'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app/callback-budget/calls.ts'), `
    export function callbackTarget() {}
    function middle() { callbackTarget(); }
    export function begin() { middle(); }
  `);
  fs.writeFileSync(path.join(root, 'app/callback-budget/page.tsx'), `
    import { useCallback as memoize } from 'react';
    import { begin } from './calls';
    export default function CallbackPage() {
      const first = memoize(() => begin(), []);
      const second = memoize(() => first(), []);
      return <button onClick={second}>Run</button>;
    }
  `);
  build();
  const output = query('impact', 'callbackTarget');
  assert.match(output, /^page \/callback-budget /m);
  assert.match(output, /^d4 call .*second < first/m);
  assert.match(output, /^d5 event .*CallbackPage < second/m);
  assert.match(output, /^# complete:/m);
});

test('impact follows a boundary callback inside an already reached owner', t => {
  const { build, query, root } = fixture(t);
  const directory = path.join(root, 'app/callback-boundary');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'calls.ts'), `
    export function boundaryTarget() {}
    function firstHop() { boundaryTarget(); }
    function secondHop() { firstHop(); }
    export function thirdHop() { secondHop(); }
    function firstRelay() { boundaryTarget(); }
    export function secondRelay() { firstRelay(); }
    export function otherTarget() {}
    function otherFirstHop() { otherTarget(); }
    function otherSecondHop() { otherFirstHop(); }
    export function otherThirdHop() { otherSecondHop(); }
  `);
  fs.writeFileSync(path.join(directory, 'page.tsx'), `
    import { useCallback } from 'react';
    import { thirdHop, secondRelay, otherThirdHop } from './calls';
    export default function BoundaryPage() {
      const refresh = useCallback(() => thirdHop(), []);
      const relay = useCallback(() => secondRelay(), []);
      const other = useCallback(() => otherThirdHop(), []);
      return <><button onClick={refresh} /><button onClick={relay} /><button onClick={other} /></>;
    }
  `);
  build();
  const output = query('impact', 'boundaryTarget');
  assert.match(output, /^page \/callback-boundary /m);
  assert.match(output, /^d\d call .*refresh < thirdHop/m);
  assert.match(output, /^# complete:/m);
  assert.match(query('impact', 'otherTarget'), /^# partial: depth limit \(1 unexplored caller/m);
  assert.match(query('impact', 'otherTarget', '--depth', '4'), /^# complete:/m);
});

test('API caller depth reaches components through a hook’s local callbacks', async t => {
  const { build, query, root, env } = fixture(t);
  for (const route of ['status', 'session']) {
    const directory = path.join(root, 'app/api', route);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'route.ts'), 'export function GET() { return Response.json({ ok: true }); }');
  }
  fs.writeFileSync(path.join(root, 'a-use-status.ts'), `
    import { useCallback, useEffect } from 'react';
    export function useStatus() {
      const fetchStatus = useCallback(() => fetch('/api/status'), []);
      const refresh = useCallback(() => fetchStatus(), [fetchStatus]);
      useEffect(() => { refresh(); }, [refresh]);
    }
  `);
  for (const [file, name] of [['status-banner.tsx', 'StatusBanner'], ['status-card.tsx', 'StatusCard']]) {
    fs.writeFileSync(path.join(root, file), `
      import { useStatus } from './a-use-status';
      export function ${name}() { useStatus(); return <p />; }
    `);
  }
  fs.writeFileSync(path.join(root, 'Session.tsx'), `
    import { useCallback } from 'react';
    export function Session() {
      const createSession = useCallback(() => fetch('/api/session'), []);
      const ensureSession = useCallback(() => createSession(), [createSession]);
      const startSession = useCallback(() => ensureSession(), [ensureSession]);
      return <button onClick={startSession} />;
    }
  `);
  const indexFile = build();
  const status = query('api_consumers', '/api/status');
  assert.match(status, /^call1 +status-banner\.tsx:\d+ useStatus$/m);
  assert.match(status, /^call1 +status-card\.tsx:\d+ useStatus$/m);
  assert.match(status, /^  call1 +a-use-status\.ts:\d+ fetchStatus$/m);
  assert.match(status, /^# complete:/m);
  assert.equal(query('api_consumers', '/api/status', '--limit', '3'), status);
  const session = query('api_consumers', '/api/session');
  assert.match(session, /^  call1 +Session\.tsx:\d+ ensureSession$/m);
  assert.match(session, /^# complete:/m);
  const { packGraph } = loadAnalyzer('../../mcp/GraphStorage');
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  const packed = packGraph(index, 0);
  assert.equal(typeof packed.packedGraph, 'string');
  fs.writeFileSync(indexFile, JSON.stringify(packed));
  assert.equal(query('api_consumers', '/api/status'), status);
  const mcp = await openMcp(t, root, {
    command: process.execPath, args: [entry, 'mcp'], cwd: root, env: { ...env, NEORION_AUTOBUILD: '0' }
  });
  assert.equal(await mcp.text('query', { kind: 'api_consumers', target: '/api/status' }), status);
  assert.doesNotMatch(await mcp.text('query', { kind: 'api_consumers', target: '/api/status', callers: 0 }), /^ *call\d/m);
});

test('API consumers climb through hooks that return memoized callbacks', async t => {
  const { build, query, root, env } = fixture(t);
  for (const [route, method] of [['track', 'POST'], ['load', 'GET'], ['reload', 'GET']]) {
    const directory = path.join(root, 'app/api', route);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'route.ts'), `export function ${method}() { return Response.json({}); }`);
  }
  fs.writeFileSync(path.join(root, 'send-track.ts'), `
    export function send(page: number) { return fetch('/api/track', { method: 'POST', body: String(page) }); }
  `);
  fs.writeFileSync(path.join(root, 'request-hooks.ts'), `
    import { useCallback } from 'react';
    import { send } from './send-track';
    export function useTracker() {
      const track = useCallback((page: number) => send(page), []);
      const start = useCallback(() => { setInterval(() => track(0), 1000); }, [track]);
      return { track, start };
    }
    export function useLoader() {
      const load = useCallback(() => fetch('/api/load'), []);
      return { load };
    }
    export function useReload() {
      const reload = useCallback(() => fetch('/api/reload'), []);
      return reload;
    }
  `);
  fs.writeFileSync(path.join(root, 'request-buttons.tsx'), `
    'use client';
    import { useTracker, useLoader, useReload } from './request-hooks';
    export function Tracker() {
      const { track, start } = useTracker();
      return <button onClick={() => { start(); track(2); }} />;
    }
    export function Loader() {
      const { load } = useLoader();
      return <button onClick={() => load()} />;
    }
    export function Reloader() {
      const reload = useReload();
      return <button onClick={() => reload()} />;
    }
  `);
  const indexFile = build();
  const track = query('api_consumers', '/api/track');
  assert.match(track, /^call1 +request-hooks\.ts:\d+ send$/m);
  assert.match(track, /^  call1 +request-hooks\.ts:\d+ track$/m);
  assert.match(track, /^# partial: caller depth limit/m);
  assert.doesNotMatch(track, /request-buttons\.tsx/);
  const expanded = query('api_consumers', '/api/track', '--depth', '2');
  assert.match(expanded, /^call2 +request-buttons\.tsx:6 track$/m);
  assert.match(expanded, /^  create2 +request-buttons\.tsx:5 useTracker$/m);
  assert.match(expanded, /^# complete:/m);
  const load = query('api_consumers', '/api/load', '--limit', '2');
  assert.match(load, /^call1 +request-buttons\.tsx:10 load$/m);
  assert.match(load, /^  create1 +request-buttons\.tsx:9 useLoader$/m);
  assert.match(load, /^# complete:/m);
  const reload = query('api_consumers', '/api/reload');
  assert.match(reload, /^call1 +request-buttons\.tsx:14 reload$/m);
  assert.match(reload, /^  create1 +request-buttons\.tsx:13 useReload$/m);
  assert.match(reload, /^# complete:/m);

  const { packGraph, unpackGraph } = loadAnalyzer('../../mcp/GraphStorage');
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  const packed = packGraph(index, 0);
  assert.deepEqual(packed.callableOwners, index.callableOwners);
  assert.deepEqual(unpackGraph(packed).callableOwners, index.callableOwners);
  fs.writeFileSync(indexFile, JSON.stringify(packed));
  const mcp = await openMcp(t, root, {
    command: process.execPath, args: [entry, 'mcp'], cwd: root, env: { ...env, NEORION_AUTOBUILD: '0' }
  });
  const consumers = (target, args) => mcp.text('query', { kind: 'api_consumers', target, ...args });
  const mcpTrack = await consumers('/api/track');
  assert.match(mcpTrack, /^# try: set depth=2/m);
  assert.equal(mcpTrack.replace(/^# try: .*\n/m, ''), track.replace(/^# try: .*\n/m, ''));
  assert.equal(await consumers('/api/track', { depth: 2 }), expanded);
  assert.equal(await consumers('/api/load', { limit: 2 }), load);
  assert.equal(await consumers('/api/reload'), reload);
  assert.doesNotMatch(await consumers('/api/track', { callers: 0 }), /^ *call\d|caller depth limit/m);

  // Existing caches still keep their lexical owners in the packed facts.
  const { deflateRawSync, inflateRawSync } = require('node:zlib');
  const { callableOwners, packedGraph, ...base } = packed;
  const facts = JSON.parse(inflateRawSync(Buffer.from(packedGraph, 'base64')));
  const legacyGraph = deflateRawSync(JSON.stringify({ ...facts, callableOwners })).toString('base64');
  fs.writeFileSync(indexFile, JSON.stringify({ ...base, packedGraph: legacyGraph }));
  assert.equal(query('api_consumers', '/api/reload'), reload);

  // Current API queries use the callback facts without inflating the graph.
  fs.writeFileSync(indexFile, JSON.stringify({ ...packed, packedGraph: 'unreadable' }));
  assert.equal(query('api_consumers', '/api/reload'), reload);
});

test('API consumers prefer callback invocations and retain ordinary caller rows at small limits', async t => {
  const { build, query, root, env } = fixture(t);
  for (const target of ['factory', 'plain', 'deferred', 'opaque', 'nested', 'forwarded']) {
    const directory = path.join(root, 'app/api', target);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'route.ts'), 'export function GET() { return Response.json({}); }');
  }
  fs.writeFileSync(path.join(root, 'request-factories.ts'), [
    "import { useCallback } from 'react';",
    'export function makeFetcher() {',
    "  const send = () => fetch('/api/factory');",
    '  const request = () => send();',
    '  return request;',
    '}',
    'export function useProfile() {',
    "  const refresh = () => fetch('/api/plain');",
    "  return { refresh, label: 'Profile' };",
    '}',
    'export function makeRequest() {',
    "  function send() { return fetch('/api/deferred'); }",
    '  function validateAndSend() { return send(); }',
    '  return validateAndSend;',
    '}',
    'export function useOpaque() {',
    "  const run = () => fetch('/api/opaque');",
    "  return { run, label: 'Opaque' };",
    '}',
    'export function useWizard() {',
    "  const send = () => fetch('/api/nested', { method: 'POST' });",
    '  const makeActions = useCallback(() => {',
    '    const save = () => send();',
    '    return { save };',
    '  }, []);',
    '  return makeActions();',
    '}',
    "function useRequest() { const run = useCallback(() => fetch('/api/forwarded'), []); return { run }; }",
    'export function useForwarded() { const request = useRequest(); return request; }'
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'request-views.tsx'), [
    "'use client';",
    "import { makeFetcher, makeRequest, useOpaque, useProfile, useWizard, useForwarded } from './request-factories';",
    'const request = makeFetcher();',
    'const deferred = makeRequest();',
    'export function FactoryButton() { return <button onClick={request} />; }',
    'export function Title() { const { label } = useProfile(); return <h1>{label}</h1>; }',
    'export function ProfileButton() { const { refresh } = useProfile(); return <button onClick={refresh} />; }',
    'export function DeferredButton() { return <button onClick={() => deferred()} />; }',
    'declare function register(callback: () => unknown): void;',
    'export function Opaque() { const { run } = useOpaque(); register(run); return null; }',
    'export function OpaqueTitle() { const { label } = useOpaque(); return <h1>{label}</h1>; }',
    'export function WizardButton() { const { save } = useWizard(); return <button onClick={save} />; }',
    'export function OpaqueButton() { const { run } = useOpaque(); return <button onClick={run} />; }',
    'export function ForwardedButton() { const { run } = useForwarded(); return <button onClick={() => run()} />; }',
    'export function ForwardedCommand() { const { run } = useForwarded(); register(run); return null; }'
  ].join('\n'));
  build();
  const factory = query('api_consumers', '/api/factory');
  assert.match(factory, /^call1 +request-factories\.ts:4 send$/m);
  assert.match(factory, /^event1 +request-views\.tsx:5 request .*onClick/m);
  assert.match(factory, /^  create1 +request-views\.tsx:3 makeFetcher$/m);
  assert.match(factory, /^# complete:/m);
  const limited = query('api_consumers', '/api/factory', '--limit', '2');
  assert.match(limited, /^call1 +request-factories\.ts:4 send$/m);
  assert.doesNotMatch(limited, /^event1/m);

  const plain = query('api_consumers', '/api/plain');
  assert.match(plain, /^event1 +request-views\.tsx:7 refresh .*onClick/m);
  assert.match(plain, /^  create1 +request-views\.tsx:6 useProfile$/m);
  assert.doesNotMatch(plain, /^ *(?:event|call)\d+ +request-views\.tsx:6\b/m);
  assert.match(plain, /^# complete:/m);
  const deferred = query('api_consumers', '/api/deferred');
  assert.match(deferred, /^call1 +request-factories\.ts:13 send$/m);
  assert.match(deferred, /^call1 +request-views\.tsx:8 validateAndSend$/m);
  assert.match(deferred, /^  create1 +request-views\.tsx:4 makeRequest$/m);
  assert.match(deferred, /^# complete:/m);

  const opaque = query('api_consumers', '/api/opaque', '--depth', '6');
  assert.match(opaque, /^  create1 +request-views\.tsx:10 useOpaque$/m);
  assert.match(opaque, /^event1 +request-views\.tsx:13 run .*onClick/m);
  assert.match(opaque, /^  create1 +request-views\.tsx:11 useOpaque$/m);
  assert.doesNotMatch(opaque, /^call\d|^event\d +request-views\.tsx:(?:10|11)\b|^# complete:/m);
  assert.match(opaque, /^# partial: unresolved caller coverage$/m);
  const nested = query('api_consumers', '/api/nested');
  assert.match(nested, /^call1 +request-factories\.ts:23 send$/m);
  assert.match(nested, /^event1 +request-views\.tsx:12 save .*onClick/m);
  assert.match(nested, /^# complete:/m);
  const forwarded = query('api_consumers', '/api/forwarded');
  assert.match(forwarded, /^call1 +request-views\.tsx:14 run$/m);
  assert.match(forwarded, /^  create1 +request-factories\.ts:29 useRequest$/m);
  assert.match(forwarded, /^  create1 +request-views\.tsx:14 useForwarded$/m);
  assert.match(forwarded, /^  create1 +request-views\.tsx:15 useForwarded$/m);
  assert.match(forwarded, /^unresolved +request-views\.tsx:15 run$/m);
  assert.match(forwarded, /^# partial: unresolved caller coverage$/m);

  const mcp = await openMcp(t, root, {
    command: process.execPath, args: [entry, 'mcp'], cwd: root, env: { ...env, NEORION_AUTOBUILD: '0' }
  });
  for (const [target, expected, depth] of [
    ['factory', factory], ['plain', plain], ['deferred', deferred], ['opaque', opaque, 6], ['nested', nested],
    ['forwarded', forwarded]
  ]) {
    assert.equal(await mcp.text('query', { kind: 'api_consumers', target: '/api/' + target, depth }), expected);
  }
});

test('API callback coverage accounts for every consumer through forwarding chains', async t => {
  const { build, root, env } = fixture(t);
  const factories = {
    hook: { name: 'useActions', callback: 'const run = () => send();' },
    factory: { name: 'makeActions', callback: 'function run() { return send(); }' },
    useCallback: { name: 'useActions', callback: 'const run = useCallback(() => send(), []);' },
    useMemo: { name: 'useActions', callback: 'const run = useMemo(() => () => send(), []);' }
  };
  const consumers = {
    call: { body: 'run(); return null;', edge: 'call', binding: '{ run }' },
    event: { body: 'return <button onClick={run} />;', edge: 'event', binding: '{ run }' },
    arrow: { body: 'return <button onClick={() => run()} />;', edge: 'call', binding: '{ run }' },
    external: { body: 'register(run); return null;', opaque: true, binding: '{ run }' },
    stored: { body: 'const registry = { run }; return <span>{Object.keys(registry)}</span>;', opaque: true, binding: '{ run }' },
    otherField: { body: 'return <span>{label}</span>;', binding: '{ label }' },
    spread: { body: 'return <button {...props} />;', opaque: true, binding: 'props' }
  };
  const cases = [];
  for (const depth of [0, 1, 2, 3]) for (const [kind, factory] of Object.entries(factories)) {
    for (const [consumer, use] of Object.entries(consumers)) for (const count of [1, 2]) {
      const slug = `matrix-${depth}-${kind.toLowerCase()}-${consumer.toLowerCase()}-${count}`;
      const route = '/api/' + slug;
      const directory = path.join(root, 'app/api', slug);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'route.ts'), 'export function GET() { return Response.json({}); }');

      const file = slug + '.tsx';
      const lines = [
        "'use client';",
        "import { useCallback, useMemo } from 'react';",
        'declare function register(callback: () => unknown): void;',
        `export function send() { return fetch('${route}'); }`,
        `function ${factory.name}() { ${factory.callback} return { run, label: 'Refresh' }; }`
      ];
      let outer = factory.name;
      const creations = [];
      for (let layer = 1; layer <= depth; layer++) {
        const name = (kind === 'factory' ? 'makeForwarded' : 'useForwarded') + layer;
        lines.push(`function ${name}() { const actions = ${outer}(); return actions; }`);
        creations.push([lines.length, outer]);
        outer = name;
      }
      const uses = count === 1 ? [use] : [use.edge === 'call' ? consumers.event : consumers.call, use];
      const invocations = [];
      for (const [index, consumer] of uses.entries()) {
        lines.push(`export function Consumer${index}() {`, `  const ${consumer.binding} = ${outer}();`, `  ${consumer.body}`, '}');
        creations.push([lines.length - 2, outer]);
        if (consumer.edge) invocations.push([lines.length - 1, consumer.edge]);
      }
      fs.writeFileSync(path.join(root, file), lines.join('\n'));
      cases.push({ route, file, opaque: uses.some(value => value.opaque), creations, invocations });
    }
  }
  build();
  const mcp = await openMcp(t, root, {
    command: process.execPath, args: [entry, 'mcp'], cwd: root, env: { ...env, NEORION_AUTOBUILD: '0' }
  });
  const query = (target, options) => mcp.text('query', { kind: 'api_consumers', target, ...options });
  const site = (file, line) => file.replace('.', '\\.') + ':' + line;
  for (const { route, file, opaque, creations, invocations } of cases) {
    const out = await query(route, { depth: 6 });
    assert.match(out, new RegExp(`^send +${site(file, 4)} send GET fetch$`, 'm'), out);
    assert.match(out, new RegExp(`^call1 +${site(file, 5)} send$`, 'm'), out);
    if (opaque) assert.match(out, /^# partial: .*unresolved caller coverage/m, out);
    else assert.match(out, /^# complete:/m, out);
    for (const [line, name] of creations) {
      assert.match(out, new RegExp(`^ +create\\d+ +${site(file, line)} ${name}$`, 'm'), out);
    }
    for (const [line, edge] of invocations) {
      assert.match(out, new RegExp(`^ *${edge}\\d+ +${site(file, line)}\\b`, 'm'), out);
    }
    const limited = await query(route, { depth: 6, limit: 2 });
    assert.match(limited, new RegExp(`^send +${site(file, 4)} send GET fetch$`, 'm'), limited);
    assert.match(limited, new RegExp(`^call1 +${site(file, 5)} send$`, 'm'), limited);
    if (opaque) {
      assert.match(limited, /^# partial: .*unresolved caller coverage/m, limited);
      const defaults = await query(route, {});
      assert.match(defaults, /^# partial: .*unresolved caller coverage/m, defaults);
    }
  }
});

test('API callback coverage handles tuple bindings and accounts for uses of one creation independently', t => {
  const { build, query, root } = fixture(t);
  for (const target of ['tuple', 'mixed', 'unused', 'dropped', 'wrapped', 'hidden', 'prop', 'exported']) {
    const directory = path.join(root, 'app/api', target);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'route.ts'), 'export function GET() { return Response.json({}); }');
  }
  fs.writeFileSync(path.join(root, 'callback-uses.tsx'), [
    "'use client';",
    "import { useCallback } from 'react';",
    'declare function register(callback: () => unknown): void;',
    'declare function wrap<T>(value: T): T;',
    "function useTuple() { const run = useCallback(() => fetch('/api/tuple'), []); return [run, 'Run'] as const; }",
    'export function Tuple() { const [run, label] = useTuple(); return <button onClick={run}>{label}</button>; }',
    "function useMixed() { const run = () => fetch('/api/mixed'); return { run }; }",
    'export function Mixed() { const { run } = useMixed(); register(run); return <button onClick={run} />; }',
    "function makeActions() { const send = () => fetch('/api/unused'); return { send, title: 'Actions' }; }",
    'export function Button() { const { send, ...labels } = makeActions(); return <button onClick={send}>{labels.title}</button>; }',
    'export function Discard() { const { send: _discard, ...labels } = makeActions(); return <span>{labels.title}</span>; }',
    "function useOriginal() { const run = () => fetch('/api/dropped'); return { run }; }",
    'function useDropped() { return wrap(useOriginal()); }',
    'export function Dropped() { const { run } = useDropped(); return <button onClick={run} />; }',
    "function useWrapped() { const run = () => fetch('/api/wrapped'); return { run }; }",
    'export function Wrapped() { const { run } = useWrapped(); register(() => (run)()); return null; }',
    "function useHidden() { const run = () => fetch('/api/hidden'); return { ...{ run } }; }",
    'export function Hidden() { const { run } = useHidden(); register(run); return null; }',
    "function useProp() { const run = () => fetch('/api/prop'); return { run }; }",
    'function Child({ action }: { action: () => Promise<Response> }) { register(action); return <button onClick={action} />; }',
    'export function Parent() { const { run } = useProp(); return <Child action={run} />; }',
    "function useExported() { const run = () => fetch('/api/exported'); return { run }; }",
    'const exportedCallback = useExported().run;',
    'export { exportedCallback };'
  ].join('\n'));
  build();
  const tuple = query('api_consumers', '/api/tuple');
  assert.match(tuple, /^event1 +callback-uses\.tsx:6 run via onClick/m);
  assert.match(tuple, /^# complete:/m);
  const mixed = query('api_consumers', '/api/mixed');
  assert.match(mixed, /^event1 +callback-uses\.tsx:8 run via onClick/m);
  assert.match(mixed, /^  create1 +callback-uses\.tsx:8 useMixed$/m);
  assert.match(mixed, /^# partial: unresolved caller coverage$/m);
  const unused = query('api_consumers', '/api/unused');
  assert.match(unused, /^event1 +callback-uses\.tsx:10 send via onClick/m);
  assert.match(unused, /^  create1 +callback-uses\.tsx:11 makeActions$/m);
  assert.match(unused, /^# complete:/m);
  const dropped = query('api_consumers', '/api/dropped', '--depth', '6');
  assert.match(dropped, /^  create1 +callback-uses\.tsx:13 useOriginal$/m);
  assert.match(dropped, /^# partial: unresolved caller coverage$/m);
  const wrapped = query('api_consumers', '/api/wrapped');
  assert.match(wrapped, /^call1 +callback-uses\.tsx:16 run$/m);
  assert.match(wrapped, /^# partial: unresolved caller coverage$/m);
  assert.match(query('api_consumers', '/api/hidden'), /^# partial: unresolved caller coverage$/m);
  const prop = query('api_consumers', '/api/prop', '--depth', '6');
  assert.match(prop, /^event1 +callback-uses\.tsx:20 run via onClick/m);
  assert.match(prop, /^# partial: unresolved caller coverage$/m);
  const exported = query('api_consumers', '/api/exported');
  assert.match(exported, /^  create1 +callback-uses\.tsx:23 useExported$/m);
  assert.match(exported, /^# partial: unresolved caller coverage$/m);
});

test('API callback coverage follows escapes of wrappers and factories used as callback values', t => {
  const { build, query, root } = fixture(t);
  for (const target of ['wrapped-chain', 'returned-factory', 'top-level', 'detached', 'inline', 'receiver']) {
    const directory = path.join(root, 'app/api', target);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'route.ts'), 'export function GET() { return Response.json({}); }');
  }
  fs.writeFileSync(path.join(root, 'callback-escapes.tsx'), [
    'declare function register(callback: () => unknown): void;',
    "function useActions() { const run = () => fetch('/api/wrapped-chain'); return { run }; }",
    'export function Button() {',
    '  const { run } = useActions();',
    '  const first = () => run();',
    '  const second = () => first();',
    '  register(second);',
    '  return <button onClick={first} />;',
    '}',
    "function makeActions() { const run = () => fetch('/api/returned-factory'); return { run }; }",
    'function makeFactory() { return makeActions; }',
    'const create = makeFactory();',
    'register(create);',
    'export function Actions() { const { run } = makeActions(); return <button onClick={run} />; }',
    "function top() { return fetch('/api/top-level'); }",
    'register(top);',
    'export function Direct() { top(); return null; }',
    "function request() { return fetch('/api/detached'); }",
    'export function Detached() { const callback = () => request(); register(callback); return null; }',
    "export function Inline() { register(() => fetch('/api/inline')); return null; }",
    "function useTuple() { const run = () => fetch('/api/receiver'); return [run] as const; }",
    'export function Receiver() { const callbacks = useTuple(); callbacks.forEach(register); callbacks[0](); return null; }'
  ].join('\n'));
  build();
  for (const [target, line] of [
    ['wrapped-chain', 7], ['returned-factory', 12], ['top-level', 16], ['detached', 19], ['inline', 20], ['receiver', 22]
  ]) {
    const out = query('api_consumers', '/api/' + target, '--depth', '6');
    assert.match(out, /^# partial: .*unresolved caller coverage/m, out);
    assert.match(out, new RegExp(`^ *(?:unresolved|create\\d+) +callback-escapes\\.tsx:${line}\\b`, 'm'), out);
  }
  const chain = query('api_consumers', '/api/wrapped-chain', '--depth', '6');
  assert.match(chain, /^call1 +callback-escapes\.tsx:5 run$/m);
  assert.match(chain, /^ *call1 +callback-escapes\.tsx:6 first$/m);
  assert.match(chain, /^ *event1 +callback-escapes\.tsx:8 first via onClick/m);
  const receiver = query('api_consumers', '/api/receiver');
  assert.match(receiver, /^call1 +callback-escapes\.tsx:22 run$/m);
});

test('API consumers label URL candidates whose template matches another route', t => {
  const { build, query, root } = fixture(t);
  for (const target of ['export-jobs/[exportId]', 'agreements/[agreementId]/responses']) {
    const directory = path.join(root, 'app/api/teams/[teamId]', target);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'route.ts'), 'export function GET() { return Response.json({}); }');
  }
  fs.writeFileSync(path.join(root, 'poll-export.tsx'), [
    "'use client';",
    'declare const activeTeam: string;',
    'declare const data: { exportId: string };',
    'function PollExport({ teamId }: { teamId: string }) {',
    '  return <button onClick={() => fetch(`/api/teams/${teamId}/export-jobs/${data.exportId}`)}>Poll</button>;',
    '}',
    'export function Exports() { return <><PollExport teamId={activeTeam} /><PollExport teamId={activeTeam} /></>; }',
    "export function Responses() { return fetch('/api/teams/team/agreements/agreement/responses'); }"
  ].join('\n'));
  build();
  const poll = query('api_consumers', '/api/teams/[teamId]/export-jobs/[exportId]');
  assert.match(poll, /^send +poll-export\.tsx:5 .*GET fetch \[partial url\]/m);
  const agreements = query('api_consumers', '/api/teams/[teamId]/agreements/[agreementId]/responses');
  assert.doesNotMatch(agreements, /^send +poll-export\.tsx:5\b/m);
  assert.match(agreements, /^candidate +poll-export\.tsx:5 .*GET fetch$/m);
  assert.match(agreements, /^  template at poll-export\.tsx:5 matches \/api\/teams\/\[teamId\]\/export-jobs\/\[exportId\]/m);
  assert.match(agreements, /^# partial: request URL from JSX prop untraced$/m);
  const limited = query('api_consumers', '/api/teams/[teamId]/agreements/[agreementId]/responses', '--limit', '1');
  assert.match(limited, /^send +poll-export\.tsx:8 Responses GET fetch$/m);
  assert.match(limited, /^candidate +poll-export\.tsx:5/m);
  assert.doesNotMatch(limited, /output truncated/);
});

test('API route callers can be traced past the default depth in CLI and MCP', async t => {
  const { build, query, root, env } = fixture(t);
  fs.mkdirSync(path.join(root, 'app/api/depth'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app/api/depth/route.ts'), 'export function GET() { return Response.json({ ok: true }); }');
  fs.writeFileSync(path.join(root, 'chain.ts'), `
    export function sendDepth() { return fetch('/api/depth'); }
    export function firstDepth() { return sendDepth(); }
    export function secondDepth() { return firstDepth(); }
    export function thirdDepth() { return secondDepth(); }
  `);
  build();
  const defaultDepth = query('api_consumers', '/api/depth');
  assert.match(defaultDepth, /^call1 .*sendDepth/m);
  assert.match(defaultDepth, /^# try: .*--depth 2/m);
  assert.match(defaultDepth, /^# partial: caller depth limit/m);
  const expanded = query('api_consumers', '/api/depth', '--depth', '3');
  assert.match(expanded, /^call3 .*secondDepth/m);
  assert.match(expanded, /^# complete:/m);
  const mcp = await openMcp(t, root, {
    command: process.execPath, args: [entry, 'mcp'], cwd: root, env: { ...env, NEORION_AUTOBUILD: '0' }
  });
  assert.equal(await mcp.text('query', { kind: 'api_consumers', target: '/api/depth', depth: 3 }), expanded);
  assert.doesNotMatch(await mcp.text('query', { kind: 'api_consumers', target: '/api/depth', callers: 0 }), /^call\d/m);
});

test('changes verifies a symbol rename against live imports and retains a stale importer', { timeout: 65_000 }, t => {
  const { file, edit, git, changes } = gitFixture(t);
  fs.writeFileSync(file('lib/measure.ts'), 'export function oldMeasure() { return 1; }\n');
  const routes = ['updated', 'stale'];
  for (const name of routes) {
    const route = file(`app/api/${name}/route.ts`);
    fs.mkdirSync(path.dirname(route), { recursive: true });
    fs.writeFileSync(route, 'import { oldMeasure } from "../../../lib/measure";\n' +
      'export const GET = () => Response.json(oldMeasure());\n');
  }
  fs.writeFileSync(file('lib/measure-type.ts'), 'import { oldMeasure } from "./measure";\n' +
    'export type Measure = ReturnType<typeof oldMeasure>;\n');
  git('add', '.');
  git('commit', '-qm', 'Add measurement importers and a type query');
  edit('lib/measure.ts', text => text.replaceAll('oldMeasure', 'newMeasure'));
  edit('lib/measure-type.ts', text => text.replaceAll('oldMeasure', 'newMeasure'));
  edit('app/api/updated/route.ts', text => text.replaceAll('oldMeasure', 'newMeasure'));
  const partialRename = changes();
  assert.match(partialRename, /^importer app\/api\/stale\/route\.ts:.* \[base\]/m);
  assert.doesNotMatch(partialRename, /^importer .*\/updated\/route\.ts|^importer lib\/measure-type\.ts/m);
  edit('app/api/stale/route.ts', text => text.replaceAll('oldMeasure', 'newMeasure'));
  const fullRename = changes();
  assert.match(fullRename, /2 routes/);
  assert.doesNotMatch(fullRename, /^importer /m);
  assert.match(fullRename, /^# complete:/m);
});

test('historical indexes keep route, import and fetch evidence while skipping overview metadata', { timeout: 65_000 }, t => {
  const { file, root, build } = gitFixture(t);
  fs.writeFileSync(file('lib/retired.ts'), 'export function retired() { return 1; }\n');
  const route = file('app/api/retired/route.ts');
  fs.mkdirSync(path.dirname(route), { recursive: true });
  fs.writeFileSync(route, 'import { retired } from "../../../lib/retired";\n' +
    '// retired used to live in a different module\nexport function GET() { return Response.json(retired()); }\n');
  fs.writeFileSync(file('app/(main)/other/request.ts'), 'export const request = () => fetch("/api/retired");\n');
  const current = JSON.parse(fs.readFileSync(build(), 'utf8'));
  const history = file('.git/history.json');
  execFileSync(process.execPath, [path.join(path.dirname(entry), 'graph.cjs'), '--history-index', root, history]);
  const historical = JSON.parse(fs.readFileSync(history, 'utf8'));
  assert.ok(current.mentions.retired?.length);
  assert.deepEqual(historical.mentions, {});
  assert.deepEqual(historical.routes, current.routes);
  assert.deepEqual(historical.moduleImports, current.moduleImports);
  assert.deepEqual(historical.fetches, current.fetches);
  assert.deepEqual(historical.references, current.references.filter(reference => ['call', 'use', 'type-use'].includes(reference[3])));
});

test('invalid changes base explains shallow and single-commit history', { timeout: 65_000 }, t => {
  const { file, git, changes } = gitFixture(t);
  assert.match(changes('--base', 'HEAD~3'), /^# partial: invalid base ref HEAD~3; only one commit is available/m);
  fs.writeFileSync(file('.git/shallow'), git('rev-parse', 'HEAD').trim() + '\n');
  assert.match(changes('--base', 'HEAD~3'), /^# partial: invalid base ref HEAD~3; shallow repository history; run git fetch --unshallow or use a reachable ref$/m);
  assert.match(changes('--base', 'nosuchbranch'), /^# partial: invalid base ref nosuchbranch; use a reachable ref$/m);
  assert.match(changes('--base', 'nosuchbranch~2'), /^# partial: invalid base ref nosuchbranch~2; use a reachable ref$/m);
});

test('MCP keeps a warm comparison graph and refreshes it when the base tree changes', { timeout: 65_000 }, async t => {
  const { root, file, edit, git, env, build } = gitFixture(t);
  edit('lib/normalize.ts', source => source.replace('export function normalize', 'function normalize'));
  build();
  const mcp = await openMcp(t, root, {
    command: process.execPath, args: [entry, 'mcp'], cwd: root, env
  });
  const query = () => mcp.text('query', { kind: 'changes' });
  const results = await Promise.all([query(), query()]);
  assert.equal(results[0], results[1]);
  assert.match(results[0], /^removed lib\/normalize\.ts normalize$/m);
  const gitDirHash = require('node:crypto').createHash('sha256').update(fs.realpathSync(file('.git'))).digest('hex');
  const history = path.join(env.XDG_CACHE_HOME, 'neorion', gitDirHash, 'history');
  const [oldTree] = fs.readdirSync(history);
  fs.unlinkSync(path.join(history, oldTree));
  assert.equal(await query(), results[0]);
  assert.deepEqual(fs.readdirSync(history), []);

  fs.writeFileSync(file('note.md'), 'Change the comparison tree.\n');
  git('add', 'note.md');
  git('commit', '-qm', 'Change the comparison tree');
  assert.match(await query(), /^removed lib\/normalize\.ts normalize$/m);
  const [newTree] = fs.readdirSync(history);
  assert.ok(newTree);
  assert.notEqual(newTree, oldTree);
});

const wrapperDispatch = `
  export function LicenseRequired({ children }) { return <section>{children}</section>; }
  export function PageWrapper({ Component, pageProps }) {
    return Component.requiresLicense ?
      <LicenseRequired><Component {...pageProps}/></LicenseRequired> : <Component {...pageProps}/>;
  }`;

test('Pages resolves a wrapper imported through the app package name', t => {
  const query = pagesReviewFixture(t, {
    'package.json': '{"name":"@fixture/web"}',
    'pages/_app.page.tsx': `
      export default function App(props) {
        const { Component } = props;
        return Component.PageWrapper ? <Component.PageWrapper {...props}/> : <Component/>;
      }`,
    'lib/wrapper.tsx': wrapperDispatch,
    'pages/self.page.tsx': `
      import { PageWrapper } from '@fixture/web/lib/wrapper';
      export default function Self() { return <main/>; }
      Self.PageWrapper = PageWrapper;
      Self.requiresLicense = true;`
  });
  const wrappers = query('wrappers', '/self');
  assert.match(wrappers, /PageWrapper assigned at pages\/self\.page\.tsx/);
  assert.match(wrappers, /LicenseRequired/);
  assert.match(wrappers, /^# complete:/m);
});

test('Pages resolves a const alias of the custom App page slot', t => {
  const query = pagesReviewFixture(t, {
    'pages/_app.page.tsx': `
      export default function App(props) {
        const { Component } = props;
        const Wrapper = Component.PageWrapper;
        const Alias = Wrapper;
        const content = Wrapper ? <Alias {...props}/> : <Component/>;
        return content;
      }`,
    'lib/wrapper.tsx': wrapperDispatch,
    'pages/alias.page.tsx': `
      import { PageWrapper } from '../lib/wrapper';
      export default function AliasPage() { return <main/>; }
      AliasPage.PageWrapper = PageWrapper;
      AliasPage.requiresLicense = true;`,
    'middleware.ts': 'export function middleware() {}'
  });
  const wrappers = query('wrappers', '/alias');
  assert.match(wrappers, /PageWrapper.*assigned at/);
  assert.match(wrappers, /LicenseRequired/);
  assert.match(wrappers, /^# complete:/m);
  assert.doesNotMatch(query('impact', 'middleware'), /custom App page slot unresolved/);
});

for (const [form, setup, jsx, usesDefault] of [
  ['logical fallback', 'const Layout = Component.Layout || DefaultLayout;', '<Layout><Component {...pageProps}/></Layout>', true],
  ['nullish fallback', 'const Layout = Component.Layout ?? DefaultLayout;', '<Layout><Component {...pageProps}/></Layout>', true],
  ['destructuring default', 'const { Layout = DefaultLayout } = Component;', '<Layout><Component {...pageProps}/></Layout>', true],
  ['nested parameter default', '', '<Layout><Component {...pageProps}/></Layout>', true],
  ['class render', 'const { Component, pageProps } = this.props; const Layout = Component.Layout || DefaultLayout;',
    '<Layout><Component {...pageProps}/></Layout>', true],
  ['let alias', 'let Layout = Component.Layout;', 'Layout ? <Layout><Component {...pageProps}/></Layout> : <Component {...pageProps}/>', false],
  ['destructured alias', 'const { Layout: Wrapper } = Component;', 'Wrapper ? <Wrapper><Component {...pageProps}/></Wrapper> : <Component {...pageProps}/>', false]
]) {
  test(`Pages resolves the custom App ${form} per page`, t => {
    const query = pagesReviewFixture(t, {
      'pages/_app.page.tsx': `
        function DefaultLayout({ children }) { return <main>{children}</main>; }
        ${form === 'class render' ? "import AppBase from 'next/app'; export default class App extends AppBase { render() {" :
          form === 'nested parameter default' ? 'export default function App({ Component: { Layout = DefaultLayout }, Component, pageProps }) {' :
            'export default function App({ Component, pageProps }) {'}
          ${setup}
          return ${jsx};
        }${form === 'class render' ? '}' : ''}`,
      'lib/page-layouts.tsx': `
        function Shell({ children }) { return <section>{children}</section>; }
        export function AdminLayout({ children }) { return <Shell>{children}</Shell>; }
        export function OtherLayout({ children }) { return <footer>{children}</footer>; }`,
      'pages/admin.page.tsx': "import { AdminLayout } from '../lib/page-layouts';\n" +
        'export default function Admin() { return <main/>; }\nAdmin.Layout = AdminLayout;',
      'pages/other.page.tsx': "import { OtherLayout } from '../lib/page-layouts';\n" +
        'export default function Other() { return <main/>; }\nOther.Layout = OtherLayout;',
      'pages/plain.page.tsx': 'export default function Plain() { return <main/>; }'
    });
    const admin = query('wrappers', '/admin');
    assert.match(admin, /AdminLayout \[Layout assigned at pages\/admin\.page\.tsx:3\]/);
    assert.match(admin, /Shell/);
    assert.match(admin, /^# complete:/m);
    assert.doesNotMatch(admin, /OtherLayout|DefaultLayout/);
    assert.match(query('wrappers', '/other'), /OtherLayout \[Layout assigned at pages\/other\.page\.tsx:3\]/);
    const plain = query('wrappers', '/plain');
    assert.match(plain, /^# complete:/m);
    if (usesDefault) {
      assert.match(plain, /DefaultLayout \[Layout fallback at pages\/_app\.page\.tsx/);
      const fallback = query('who_renders', 'DefaultLayout');
      assert.match(fallback, /^\/plain .* \[via layout\]/m);
      assert.doesNotMatch(fallback, /^\/(?:admin|other) /m);
    } else {
      assert.doesNotMatch(plain, /DefaultLayout|AdminLayout|OtherLayout/);
    }
    for (const component of ['AdminLayout', 'Shell']) {
      const renders = query('who_renders', component);
      assert.match(renders, /^\/admin .* \[via layout\]/m);
      assert.doesNotMatch(renders, /^\/(?:plain|other) /m);
      assert.match(renders, /^# complete:/m);
    }
  });
}

test('Pages expands nested children in an inline layout and forwarded children in an inline props layout', t => {
  const query = pagesReviewFixture(t, {
    'pages/_app.page.tsx': 'export default function App({ Component }) { return <Component.Layout><Component/></Component.Layout>; }',
    'pages/index.page.tsx': `
      function Outer({ children }) { return <main>{children}</main>; }
      function Inner({ children }) { return <section>{children}</section>; }
      export default function Page() { return <div/>; }
      Page.Layout = ({ children }) => <Outer><Inner>{children}</Inner></Outer>;`,
    'pages/forward.page.tsx': `
      import { Outer, Inner } from '../lib/layouts';
      export default function Page() { return <div/>; }
      Page.Layout = props => <Outer><Inner {...props}/></Outer>;`,
    'lib/layouts.tsx': 'export function Outer({ children }) { return <main>{children}</main>; }\n' +
      'export function Inner({ children }) { return <section>{children}</section>; }'
  });
  for (const route of ['/', '/forward']) {
    const output = query('wrappers', route);
    assert.match(output, /Layout \[Layout assigned at /);
    assert.match(output, /\bOuter\b/);
    assert.match(output, /\bInner\b/);
    assert.match(output, /^# complete:/m);
  }
});

test('Pages labels a guarded Layout reassignment and preserves partial for unsupported writes', t => {
  const source = `
    function DefaultLayout({ children }) { return <main>{children}</main>; }
    function OtherLayout({ children }) { return <section>{children}</section>; }
    export default function App({ Component, pageProps, router }) {
      let Layout = Component.Layout ?? DefaultLayout;
      if (router.isPreview) Layout = OtherLayout;
      return <Layout><Component {...pageProps}/></Layout>;
    }`;
  const { root, query, build } = fixture(t, false, path.join(__dirname, 'fixtures/pages-router'));
  const app = path.join(root, 'pages/_app.page.tsx');
  fs.writeFileSync(app, source);
  fs.writeFileSync(path.join(root, 'pages/inline.page.tsx'), `
    function InlineChild({ children }) { return <article>{children}</article>; }
    export default function InlinePage() { return <main/>; }
    InlinePage.Layout = ({ children }) => <InlineChild>{children}</InlineChild>;
  `);
  build();
  const output = query('wrappers', '/');
  assert.match(output, /DefaultLayout .*\[cond\]/);
  assert.match(output, /OtherLayout .*\[cond\]/);
  assert.match(output, /^# complete:/m);
  assert.match(query('who_renders', 'OtherLayout'), /^\/ .*\[cond\]/m);
  const inline = query('who_renders', 'InlineChild');
  assert.match(inline, /^\/inline .*\[cond\]/m);
  assert.match(inline, /^# complete:/m);
  fs.writeFileSync(app, source.replace('if (router.isPreview) Layout = OtherLayout;', 'router.onChange(() => { Layout = OtherLayout; });'));
  build();
  assert.match(query('wrappers', '/'), /^# partial:.*unresolved page property Layout/m);
});

const reviewedLayouts = {
  'lib/review-layouts.tsx': [
    'export function Shell({ children }) { return <section>{children}</section>; }',
    'export function AdminLayout({ children }) { return <Shell>{children}</Shell>; }',
    'export function EmptyLayout({ children }) { return <main>{children}</main>; }',
    'export function MarketingLayout({ children }) { return <footer>{children}</footer>; }'
  ].join('\n'),
  'pages/review-plain.page.tsx': 'export default function Plain() { return <main/>; }'
};
const reviewAdmin = "import { AdminLayout } from '../lib/review-layouts';\n" +
  'export default function Admin() { return <main/>; }\n';
const reviewedApp = "import { EmptyLayout, MarketingLayout } from '../lib/review-layouts';\n" +
  'export default function MyApp({ Component, pageProps, router }) {';

for (const [form, setup, admin, plain, conditional] of [
  ['guarded page layout', 'let Layout = EmptyLayout; if (Component.Layout) Layout = Component.Layout;', 'AdminLayout', 'EmptyLayout'],
  ['braced guarded page layout', 'let Layout = EmptyLayout; if (Component.Layout) { Layout = Component.Layout; }', 'AdminLayout', 'EmptyLayout'],
  ['truthy ternary', 'const Layout = Component.Layout ? Component.Layout : EmptyLayout;', 'AdminLayout', 'EmptyLayout'],
  ['nullish ternary', 'const Layout = Component.Layout != null ? Component.Layout : EmptyLayout;', 'AdminLayout', 'EmptyLayout'],
  ['const component alias', 'const Layout = EmptyLayout;', 'EmptyLayout', 'EmptyLayout'],
  ['let component alias', 'let Layout = EmptyLayout;', 'EmptyLayout', 'EmptyLayout'],
  ['guarded replacement', "let Layout = EmptyLayout; if (router.pathname === '/m') Layout = MarketingLayout;",
    'EmptyLayout', 'EmptyLayout', 'both'],
  ['else-if replacement', "let Layout = EmptyLayout; if (Component.Layout) { Layout = Component.Layout; } " +
    "else if (router.pathname === '/m') { Layout = MarketingLayout; }", 'AdminLayout', 'EmptyLayout', 'plain'],
  ['last write', 'let Layout = Component.Layout || EmptyLayout; Layout = MarketingLayout;', 'MarketingLayout', 'MarketingLayout'],
  ['falsy alias guard', 'let Layout = Component.Layout; if (!Layout) Layout = EmptyLayout;', 'AdminLayout', 'EmptyLayout']
]) {
  test(`Pages traces App wrappers for ${form}`, t => {
    const query = pagesReviewFixture(t, {
      ...reviewedLayouts,
      'pages/_app.page.tsx': `${reviewedApp} ${setup} return <Layout><Component {...pageProps}/></Layout>; }`,
      'pages/review-admin.page.tsx': reviewAdmin + 'Admin.Layout = AdminLayout;'
    });
    for (const [route, component, branch] of [
      ['/review-admin', admin, conditional === 'both'],
      ['/review-plain', plain, !!conditional]
    ]) {
      const wrappers = query('wrappers', route);
      assert.match(wrappers, /^# complete:/m);
      assert.doesNotMatch(wrappers, /MyApp, Layout\b/);
      for (const layout of ['AdminLayout', 'EmptyLayout', 'MarketingLayout']) {
        const expected = layout === component || branch && layout === 'MarketingLayout';
        assert.equal(wrappers.includes(layout), expected, wrappers);
      }
      if (branch) {
        assert.match(wrappers, new RegExp(component + '.*\\[cond\\]'));
        assert.match(wrappers, /MarketingLayout .*\[cond\]/);
      } else assert.doesNotMatch(wrappers, /\[cond\]/);
    }
    for (const [component, routes] of [
      [admin, ['/review-admin']],
      [plain, ['/review-plain']],
      ...(conditional ? [['MarketingLayout', conditional === 'both' ? ['/review-admin', '/review-plain'] : ['/review-plain']]] : [])
    ]) {
      const renders = query('who_renders', component);
      for (const route of routes) assert.match(renders, new RegExp('^' + route + ' .*\\[via layout\\]', 'm'));
      assert.match(renders, /^# complete:/m);
    }
  });
}

for (const [form, setup, invoke] of [
  ['switch', "let Layout; switch (router.pathname) { case '/m': Layout = MarketingLayout; break; " +
    'default: Layout = Component.Layout || EmptyLayout; }', '<Layout><Component/></Layout>'],
  ['opaque JSX alias', 'const Layout = unknownLayout();', '<Layout><Component/></Layout>'],
  ['opaque getLayout alias', 'const getLayout = unknownLayout();', 'getLayout(<Component/>)'],
  ['opaque forwarded JSX alias', 'const Layout = unknownLayout();', '<Layout Component={Component}/>']
]) {
  test(`Pages reports a partial App slot for ${form}`, t => {
    const query = pagesReviewFixture(t, {
      ...reviewedLayouts,
      'pages/_app.page.tsx': `${reviewedApp} ${setup} return ${invoke}; }`,
      'pages/review-admin.page.tsx': reviewAdmin + 'Admin.Layout = AdminLayout;'
    });
    const wrappers = query('wrappers', '/review-admin');
    assert.doesNotMatch(wrappers, /MyApp, Layout\b|MyApp, getLayout\b/);
    assert.match(wrappers, /^# partial: custom App page slot unresolved$/m);
    assert.match(query('who_renders', 'AdminLayout'), /^# partial: custom App page slot unresolved$/m);
  });
}

for (const [form, setup] of [
  ['ternary', 'const getLayout = Component.getLayout ? Component.getLayout : page => page;'],
  ['guarded write', 'let getLayout = page => page; if (Component.getLayout) getLayout = Component.getLayout;']
]) {
  test(`Pages resolves getLayout selected by a ${form}`, t => {
    const query = pagesReviewFixture(t, {
      ...reviewedLayouts,
      'pages/_app.page.tsx': `${reviewedApp} ${setup} return getLayout(<Component {...pageProps}/>); }`,
      'pages/review-admin.page.tsx': reviewAdmin + 'Admin.getLayout = page => <AdminLayout>{page}</AdminLayout>;',
      'lib/review-get-layout.tsx': "import { AdminLayout } from './review-layouts';\n" +
        'export function getAdminLayout(page) { return <AdminLayout>{page}</AdminLayout>; }',
      'pages/review-named.page.tsx': "import { getAdminLayout } from '../lib/review-get-layout';\n" +
        'export default function Named() { return <main/>; }\nNamed.getLayout = getAdminLayout;'
    });
    const admin = query('wrappers', '/review-admin');
    assert.match(admin, /AdminLayout \[getLayout at .*; assigned at pages\/review-admin\.page\.tsx:3\]/);
    assert.match(admin, /^# complete:/m);
    const plain = query('wrappers', '/review-plain');
    assert.doesNotMatch(plain, /AdminLayout|branch A/);
    assert.match(plain, /^# complete:/m);
    const reverse = query('who_renders', 'AdminLayout');
    assert.match(reverse, /^\/review-admin .*depth 1/m);
    assert.match(reverse, /^\/review-named .*\[via layout\]/m);
    assert.match(reverse, /^# complete:/m);
  });
}

test('Pages keeps a forwarded Component alias as the page slot', t => {
  const query = pagesReviewFixture(t, {
    ...reviewedLayouts,
    'pages/_app.page.tsx': `import { EmptyLayout } from '../lib/review-layouts';
      export default function MyApp(props) {
        const CurrentPage = props.Component;
        const Layout = EmptyLayout;
        return <Layout><CurrentPage {...props}/></Layout>;
      }`
  });
  const output = query('wrappers', '/review-plain');
  assert.match(output, /EmptyLayout/);
  assert.doesNotMatch(output, /CurrentPage/);
  assert.match(output, /^# complete:/m);
});

test('Pages resolves or suppresses local wrapper aliases in a custom App HOC', t => {
  const query = pagesReviewFixture(t, {
    ...reviewedLayouts,
    'pages/_app.page.tsx': `import { EmptyLayout } from '../lib/review-layouts';
      function withApp(Inner) {
        return props => {
          const OuterAlias = EmptyLayout;
          const OpaqueAlias = unknownLayout();
          return <OuterAlias><OpaqueAlias><Inner {...props}/></OpaqueAlias></OuterAlias>;
        };
      }
      function MyApp({ Component }) { return <Component/>; }
      export default withApp(MyApp);`
  });
  const output = query('wrappers', '/review-plain');
  assert.match(output, /EmptyLayout/);
  assert.doesNotMatch(output, /OuterAlias|OpaqueAlias/);
  assert.match(output, /^# partial: custom App page slot unresolved$/m);
});

test('Pages preserves JSX lines and named render hops through inline page layouts', t => {
  const query = pagesReviewFixture(t, {
    ...reviewedLayouts,
    'pages/_app.page.tsx': `${reviewedApp} const Layout = Component.Layout ?? EmptyLayout;
      return <Layout><Component/></Layout>; }`,
    'pages/review-arrow.page.tsx': reviewAdmin +
      '\nAdmin.Layout = ({ children }) => (\n  <AdminLayout>{children}</AdminLayout>\n);',
    'pages/review-block.page.tsx': reviewAdmin +
      'Admin.Layout = ({ children }) => {\n  if (Date.now()) return <AdminLayout>{children}</AdminLayout>;\n' +
      '  return <section>{children}</section>;\n};',
    'pages/review-function.page.tsx': reviewAdmin +
      'Admin.Layout = function InlineLayout({ children }) { return <AdminLayout>{children}</AdminLayout>; };'
  });
  const arrow = query('path', '/review-arrow', 'Shell');
  assert.match(arrow, /2 hops/);
  assert.match(arrow, /^1 render pages\/review-arrow\.page\.tsx:5 AdminLayout$/m);
  assert.match(arrow, /^2 render lib\/review-layouts\.tsx:2 Shell$/m);
  assert.match(query('path', '/review-block', 'AdminLayout'), /^1 render pages\/review-block\.page\.tsx:4 AdminLayout .*\[cond\]$/m);
  const output = query('wrappers', '/review-function');
  assert.match(output, /Layout \[Layout assigned at pages\/review-function\.page\.tsx:3\]/);
  assert.match(output, /AdminLayout, Shell/);
  assert.match(output, /^# complete:/m);
  const reverse = query('who_renders', 'Shell');
  for (const form of ['arrow', 'block', 'function']) {
    assert.match(reverse, new RegExp('^/review-' + form + ' .*depth 2 via AdminLayout \\[via layout\\]', 'm'));
  }
  assert.match(reverse, /^# complete:/m);
});

test('Pages follows a class App render helper and preserves the enclosing wrapper', t => {
  const query = pagesReviewFixture(t, {
    ...reviewedLayouts,
    'pages/_app.page.tsx': `import { EmptyLayout } from '../lib/review-layouts';
      export default class MyApp {
        render() { return <EmptyLayout>{this.renderPage()}</EmptyLayout>; }
        renderPage() { return this.renderContent(); }
        renderContent() { const { Component, pageProps } = this.props; return <Component {...pageProps}/>; }
      }`
  });
  const output = query('wrappers', '/review-plain');
  assert.match(output, /MyApp/);
  assert.match(output, /EmptyLayout/);
  assert.match(output, /^# complete:/m);
  assert.match(query('who_renders', 'EmptyLayout'), /^\/review-plain .*\[via layout\]/m);
});

test('Pages ignores unused layout properties while keeping diagnostics for a consumed opaque property', t => {
  const query = pagesReviewFixture(t, {
    ...reviewedLayouts,
    'pages/_app.page.tsx': `${reviewedApp} const Layout = Component.Layout || EmptyLayout;
      if (Component.getLayout) { const discarded = <EmptyLayout/>; }
      return <Layout><Component/></Layout>; }`,
    'pages/review-admin.page.tsx': reviewAdmin + 'Admin.Layout = AdminLayout;\n' +
      'Admin.getLayout = unknownLayout();\nAdmin.layout = unknownLayout();',
    'pages/review-unknown.page.tsx': 'export default function Unknown() { return <main/>; }\n' +
      'Unknown.Layout = unknownLayout();\nUnknown.getLayout = unknownLayout();\nUnknown.layout = unknownLayout();'
  });
  assert.match(query('wrappers', '/review-admin'), /^# complete:/m);
  assert.match(query('wrappers', '/review-unknown'), /^# partial: unresolved page property Layout$/m);
  const renders = query('who_renders', 'AdminLayout');
  assert.match(renders, /^\/review-admin .*\[via layout\]/m);
  assert.match(renders, /^# partial: unresolved page property Layout$/m);
  assert.doesNotMatch(renders, /unresolved page property (getLayout|layout)\b/);
});

test('a Pages App excluded by tsconfig stays partial for wrapper and reverse render queries', t => {
  const query = pagesReviewFixture(t, {
    'tsconfig.json': JSON.stringify({ include: ['**/*.ts', '**/*.tsx'], compilerOptions: { jsx: 'preserve', allowJs: true } }),
    'next.config.js': 'module.exports = {};',
    'pages/_app.jsx': "import { EmptyLayout } from '../lib/layout'; export default function App({ Component }) { return <EmptyLayout><Component/></EmptyLayout>; }",
    'lib/layout.tsx': 'export function EmptyLayout({ children }) { return <main>{children}</main>; }',
    'pages/excluded.tsx': 'function Visible() { return <main/>; }\nexport default function Page() { return <Visible/>; }'
  });
  assert.match(query('wrappers', '/excluded'), /^# partial:.*custom App unresolved/m);
  assert.match(query('who_renders', 'EmptyLayout'), /^# partial:.*custom App unresolved/m);
  assert.match(query('path', '/excluded', 'EmptyLayout'), /^# partial:.*custom App unresolved/m);
  const matched = query('path', '/excluded', 'Visible');
  assert.match(matched, /1 hop/);
  assert.match(matched, /^# partial:.*custom App unresolved/m);
});

test('a destructured App can forward Component directly through a fallback alias', t => {
  const query = pagesReviewFixture(t, {
    'pages/_app.page.tsx': `
      function DefaultWrapper({ Component, pageProps }) { return <Component {...pageProps}/>; }
      export default function App({ Component, pageProps }) {
        const Wrapper = Component.PageWrapper ?? DefaultWrapper;
        return <Wrapper Component={Component} pageProps={pageProps}/>;
      }`,
    'lib/wrapper.tsx': wrapperDispatch,
    'pages/licensed.page.tsx': `
      import { PageWrapper } from '../lib/wrapper';
      export default function Licensed() { return <main/>; }
      Licensed.PageWrapper = PageWrapper;
      Licensed.requiresLicense = true;`,
    'pages/plain.page.tsx': 'export default function Plain() { return <main/>; }'
  });
  const licensed = query('wrappers', '/licensed');
  assert.match(licensed, /PageWrapper assigned at /);
  assert.match(licensed, /LicenseRequired/);
  assert.match(licensed, /^# complete:/m);
  const plain = query('wrappers', '/plain');
  assert.match(plain, /DefaultWrapper \[PageWrapper fallback at /);
  assert.match(plain, /^# complete:/m);
  assert.match(query('who_renders', 'LicenseRequired'), /^\/licensed .* \[via layout\]/m);
});

test('a reassigned or unresolved App layout alias keeps render and wrapper coverage partial', t => {
  const query = pagesReviewFixture(t, {
    'pages/_app.page.tsx': `
      declare const getLayout: () => any;
      export default function App({ Component, pageProps }) {
        let Layout = Component.Layout;
        Layout = getLayout();
        return <Layout><Component {...pageProps}/></Layout>;
      }`,
    'pages/probe.page.tsx': `
      export function ProbeLayout({ children }) { return <main>{children}</main>; }
      export default function Probe() { return <main/>; }
      Probe.Layout = ProbeLayout;`
  });
  assert.match(query('wrappers', '/probe'), /^# partial: unresolved page property Layout$/m);
  assert.match(query('who_renders', 'ProbeLayout'), /^# partial: unresolved page property Layout$/m);
});

test('an unresolved App alias leaves who_renders partial even when another page has a known assignment', t => {
  const query = pagesReviewFixture(t, {
    'pages/_app.page.tsx': `
      export default function App({ Component }) {
        const Layout = Component.Layout;
        return Layout ? <Layout><Component/></Layout> : <Component/>;
      }`,
    'lib/probe-layout.tsx': 'export function ProbeLayout({ children }) { return <main>{children}</main>; }',
    'pages/probe.page.tsx': `
      import { ProbeLayout } from '../lib/probe-layout';
      export default function Probe() { return <main/>; }
      Probe.Layout = ProbeLayout;`,
    'pages/uncertain.page.tsx': `
      import { ProbeLayout } from '../lib/probe-layout';
      export default function Uncertain() { return <main/>; }
      if (Date.now()) Uncertain.Layout = ProbeLayout;`
  });
  const renders = query('who_renders', 'ProbeLayout');
  assert.match(renders, /^\/probe .* \[via layout\]/m);
  assert.match(renders, /^# partial: unresolved page property Layout$/m);
});

test('an unguarded App slot with a missing page property stays partial', t => {
  const query = pagesReviewFixture(t, {
    'pages/_app.page.tsx': `
      export default function App(props) {
        const { Component } = props;
        const Wrapper = Component.PageWrapper;
        return <Wrapper {...props}/>;
      }`,
    'pages/missing.page.tsx': 'export default function Missing() { return <main/>; }'
  });
  assert.match(query('wrappers', '/missing'), /^# partial: missing page property PageWrapper in a reachable App slot$/m);
});

test('Pages callbacks after an early return and in a try block are checker-resolved', t => {
  const config = {
    guard: 'if (!ctx.session) return { redirect: { destination: "/" } }; return callback(ctx);',
    caught: 'try { return await callback(ctx); } catch { return { notFound: true }; }',
    branch: 'if (ctx.session) return callback(ctx); return { notFound: true };',
    dead: 'try { return { props: {} }; } finally {} return callback(ctx);'
  };
  const query = pagesReviewFixture(t, Object.fromEntries(Object.entries(config).map(([name, body]) => [
    `pages/${name}.page.tsx`,
    `export default function Page() { return <main />; }
     function wrap(callback) { return async ctx => { ${body} }; }
     function load_${name}() { return { props: {} }; }
     export const getServerSideProps = wrap(() => load_${name}());`
  ])));
  for (const name of ['guard', 'caught']) {
    const result = query('path', '/' + name, 'load_' + name);
    assert.match(result, /2 call .*load_/);
    assert.doesNotMatch(result, /\[possible\]/);
    assert.match(result, /^# complete:/m);
  }
  assert.match(query('path', '/branch', 'load_branch'), /\[possible\][\s\S]*# partial:/);
  assert.match(query('path', '/dead', 'load_dead'), /# complete: no directed path/);
});

test('Pages wrapper evidence uses the defining module when a page re-exports its default', t => {
  const query = pagesReviewFixture(t, {
    'pages/_app.page.tsx': `
      export default function App(props) {
        const { Component } = props;
        return Component.PageWrapper ? <Component.PageWrapper {...props}/> : <Component/>;
      }`,
    'lib/wrapper.tsx': wrapperDispatch,
    'lib/view.tsx': [
      "import { PageWrapper } from './wrapper';",
      'export default function View() { return <main/>; }',
      'View.PageWrapper = PageWrapper;',
      'View.requiresLicense = true;'
    ].join('\n'),
    'pages/reexport.page.tsx': "export { default } from '../lib/view';"
  });
  const result = query('impact', 'PageWrapper');
  assert.match(result, /^d1 module lib\/view\.tsx:3 /m);
  assert.doesNotMatch(result, /^d1 .*pages\/reexport\.page\.tsx:[2-9]/m);
  assert.match(query('path', '/reexport', 'PageWrapper'), /^1 render lib\/view\.tsx:3 /m);
});

test('packed Pages dependencies preserve method, lifecycle and matcher evidence', t => {
  const { root, build, query } = fixture(t, false, path.join(__dirname, 'fixtures/pages-router'));
  // Cross the packing threshold without adding routes or changing the Pages adapter.
  fs.writeFileSync(path.join(root, 'large.ts'), Array.from({ length: 4_000 }, (_, i) =>
    `export const entry${i} = ${i};`).join('\n'));
  const index = JSON.parse(fs.readFileSync(build(), 'utf8'));
  const { inflateRawSync } = require('node:zlib');
  const packed = JSON.parse(inflateRawSync(Buffer.from(index.packedGraph, 'base64')).toString('utf8'));
  assert.ok(packed.pagesEdges.some(edge => edge.kind === 'middleware'));
  assert.ok(packed.pagesEdges.some(edge => edge.kind === 'data'));
  assert.equal(index.pagesEdges, undefined);
  assert.match(query('path', '/api/auth/csrf/embed', 'middleware'), /1 middleware/);
  assert.match(query('api_consumers', '/api/auth/signup'), /# methods enforced: POST/);
});

test('Pages middleware impact explains template overlap and dynamic Next configuration', t => {
  const query = pagesReviewFixture(t, {
    'next.config.js': 'module.exports = () => ({ pageExtensions: ["page.tsx", "page.ts"] });',
    'middleware.ts': `
      export function middleware() {}
      export const config = { matcher: '/:path*/embed' };`
  });
  const impact = query('impact', 'middleware', '--limit', '80');
  assert.match(impact, /0 exact, [1-9]\d* possible Pages routes/);
  assert.match(impact, /^# partial: .*middleware matcher "\/:path\*\/embed" may overlap dynamic route templates; dynamic next\.config can change URL matching/m);
  assert.match(impact, /^# partial:/m);
  assert.doesNotMatch(query('path', '/api/auth/csrf/embed', 'middleware'), /\[possible\]/);
});

const routerFixture = (t, name) => fixture(t, false, path.join(__dirname, 'fixtures', name));

test('React Router Framework registrations, entry roles, Outlet chains and router-bound calls', async t => {
  const app = routerFixture(t, 'react-router-config');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args],
    { cwd: app.root, env: app.env, stdio: 'ignore' });
  git('init', '-q');
  git('add', '.');
  git('commit', '-qm', 'Fixture');
  const data = path.join(app.root, 'src/ui/data.ts');
  fs.writeFileSync(data, fs.readFileSync(data, 'utf8').replace('export function load() {',
    'export function load() {\n  if (false) throw new Error();'));
  const index = JSON.parse(fs.readFileSync(app.build(), 'utf8'));
  const registered = new Map(index.routes.map(route => [route.router.id, route]));
  assert.equal(index.router.framework, 'react-router');
  assert.equal(index.router.basename, '/site');
  assert.equal(registered.get('left').router.parentId, 'section');
  assert.equal(registered.get('left').file, registered.get('right').file);
  assert.equal(registered.get('home').router.index, true);
  assert.equal(registered.get('case-sensitive').router.caseSensitive, true);
  assert.equal(registered.get('receiver').kind, 'api');
  assert.deepEqual(registered.get('receiver').methods, ['GET', '?']);
  assert.deepEqual(registered.get('guarded').methods, ['POST']);
  assert.equal(registered.get('guarded').methodBasis, 'enforced');
  assert.deepEqual(registered.get('left').router.entries.map(entry => entry.role), [
    'render', 'loader', 'action', 'client-loader', 'client-action', 'meta', 'links', 'headers', 'error-boundary', 'hydrate-fallback'
  ]);
  assert.equal(registered.get('left').router.entries.find(entry => entry.role === 'loader').file, 'src/ui/data.ts');
  assert.equal(registered.get('unmounted').router.renderable, false);
  const edges = index.router.edges;
  assert.ok(edges.some(edge => edge.kind === 'submit' && edge.source === registered.get('left').id && edge.destination === edge.source));
  assert.ok(edges.some(edge => edge.kind === 'submit' && edge.source === registered.get('right').id && edge.destination === edge.source));
  assert.ok(edges.some(edge => edge.kind === 'submit' && edge.destination === registered.get('index-form').id));
  assert.ok(edges.some(edge => edge.kind === 'redirect' && edge.file === 'src/ui/data.ts' && edge.destination === registered.get('receiver').id));
  assert.ok(edges.some(edge => edge.detail === 'useRouteLoaderData → loader' && edge.destination === registered.get('root').id));
  assert.ok(!edges.some(edge => edge.detail.includes('LocalLink')));
  assert.ok(edges.some(edge => edge.kind === 'navigate' && edge.source === registered.get('right').id &&
    edge.destination === registered.get('left').id));
  assert.match(app.query('wrappers', '/site/gate/child'), /# partial: conditional outlet slot/);
  assert.match(app.query('path', 'route:receiver', 'src/ui/receiver.ts#loader'), /1 data src\/ui\/receiver.ts[^\n]+loader/);
  assert.match(app.query('path', '/site/panel/right', '/site/panel/left'), /1 navigate src\/ui\/route.tsx[^\n]+Link/);
  assert.match(app.query('wrappers', '/site/Case'), /^# wrappers \/Case /m);
  assert.doesNotMatch(app.query('wrappers', '/site/case'), /^page /m);
  assert.match(app.query('wrappers', '/site/users/123'), /^# wrappers \/users\/:id\? /m);
  assert.match(app.query('wrappers', '/site/files/folder/readme'), /^# wrappers \/files\/\* /m);
  assert.match(app.query('wrappers', 'src/ui/route.tsx'), /route:left[\s\S]+route:right/);
  assert.doesNotMatch(app.query('who_renders', 'MissingBanner'), /^\/uncoupled\/child /m);
  assert.match(app.query('wrappers', '/site/uncoupled/child'), /^# partial: outlet slot unresolved/m);
  const mcp = await openMcp(t, app.root, {
    command: process.execPath, args: [entry, 'mcp', '--root', app.root], env: app.env, cwd: app.root
  });
  for (const [kind, target, cli, options, expected] of [
    ['search', '/', ['--kind', 'route'], { filter: 'route' }, /route:left/],
    ['wrappers', '/site/panel/left', [], {}, /Layout.*ShellProvider[\s\S]*Section[\s\S]*page src\/ui\/route.tsx/],
    ['who_renders', 'Banner', [], {}, /\/panel\/left[^\n]+\[via layout\]/],
    ['rename_impact', 'Banner', [], {}, /src\/ui\/root.tsx/],
    ['api_consumers', 'route:receiver', [], {}, /POST fetcher.Form[\s\S]*GET fetcher.load[\s\S]*PATCH fetcher.submit/],
    ['impact', 'src/ui/data.ts#load', [], {}, /page \/panel\/left[\s\S]*page \/panel\/right/],
    ['callees', 'route:left', [], {}, /data[^\n]+\(loader\)[\s\S]*navigate[^\n]+\(Link\)/],
    ['path', 'route:left', ['route:receiver'], { to: 'route:receiver' }, /1 redirect src\/ui\/data.ts/],
    ['changes', undefined, ['--unstaged'], { scope: 'unstaged' }, /route page \/panel\/left[\s\S]*changed src\/ui\/data.ts[^\n]+load/]
  ]) {
    const stdout = app.query(kind, ...(target ? [target] : []), ...cli);
    assert.match(stdout, expected, kind);
    assert.match(stdout, /^# (?:complete|partial): /m);
    assert.equal(await mcp.text('query', { kind, ...target && { target }, ...options }), stdout, kind);
  }
});

test('React Router flatRoutes and Remix flat files preserve filename syntax and actual parents', t => {
  for (const [fixtureName, mode, cases, omitted] of [
    ['react-router-files', 'react-router', [
      ['screens/_index', '/', 'root', true],
      ['screens/reports.$year', '/reports/:year', 'screens/reports', false],
      ['screens/reports_.standalone', '/reports/standalone', 'root', false],
      ['screens/($lang).catalog.$', '/:lang?/catalog/*', 'root', false],
      ['screens/feed[.]xml', '/feed.xml', 'root', false]
    ], 'ignored.tsx'],
    ['remix-v2', 'remix', [
      ['routes/_index', '/', 'root', true],
      ['routes/_auth.login', '/login', 'routes/_auth', false],
      ['routes/docs._index', '/docs', 'routes/docs', true],
      ['routes/docs_.$', '/docs/*', 'root', false],
      ['routes/($lang).catalog', '/:lang?/catalog', 'root', false],
      ['routes/feed[.]xml', '/feed.xml', 'root', false]
    ], 'helper.tsx'],
    ['react-router-auto', 'react-router', [
      ['routes/_account/login', '/login', 'routes/_account/_layout', false],
      ['routes/docs/route', '/docs', 'root', false]
    ], 'help.test.tsx']
  ]) {
    const app = routerFixture(t, fixtureName);
    const index = JSON.parse(fs.readFileSync(app.build(), 'utf8'));
    assert.equal(index.router.framework, mode);
    const registrations = new Map(index.routes.map(route => [route.router.id, route]));
    for (const [id, url, parent, index] of cases) {
      const route = registrations.get(id);
      assert.deepEqual([route.url, route.router.parentId, !!route.router.index], [url, parent, index], id);
    }
    assert.ok(![...registrations.values()].some(route => route.file.endsWith(omitted) || route.file.includes('/+/')));
    if (mode === 'remix') {
      assert.match(app.query('api_consumers', '/feed.xml'), /load web\/routes\/_auth.login.tsx:[0-9]+ GET fetcher.load/);
      assert.match(app.query('path', '/login', '/feed.xml'), /1 redirect web\/routes\/_auth.login.tsx/);
      assert.match(app.query('wrappers', '/login'), /AuthLayout/);
    }
  }
});

test('path-bearing index routes receive data requests before catch-alls', t => {
  const modules = `
    export function loader() { return null; }
    export function action() { return null; }
    export default function View() { return <p>Content</p>; }
  `;
  for (const [fixtureName, directory, users, home, registration] of [
    ['react-router-auto', 'app/routes', 'users/index.tsx', 'index.tsx', 'routes/users/index'],
    ['react-router-files', 'app/screens', 'users._index.tsx', '_index.tsx', 'screens/users._index'],
    ['remix-v2', 'web/routes', 'users._index.tsx', '_index.tsx', 'routes/users._index'],
    ['react-router-config', 'src/ui', 'users-index.tsx', 'home.tsx', 'users-index']
  ]) {
    const app = routerFixture(t, fixtureName);
    const write = (name, content) => {
      const file = path.join(app.root, directory, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    };
    write(users, modules);
    write('$.tsx', modules);
    const explicit = fixtureName === 'react-router-config';
    const remix = fixtureName === 'remix-v2';
    if (explicit) {
      fs.unlinkSync(path.join(app.root, directory, 'index-form.tsx'));
      fs.unlinkSync(path.join(app.root, directory, 'route.tsx'));
      const registry = path.join(app.root, directory, 'registry.ts');
      fs.writeFileSync(registry, `
        import { register, index, prefix } from './helpers';
        export const registry = [index('home.tsx'), ...prefix('users', [index('users-index.tsx')]), register('*', '$.tsx')];
      `);
    }
    write(home, `
      import { Form, useFetcher, useSubmit } from '${remix ? '@remix-run/react' : 'react-router'}';
      export default function IndexRequests() {
        const fetcher = useFetcher();
        const submit = useSubmit();
        fetcher.load('/users');
        fetcher.submit({}, { method: 'post', action: '/users' });
        submit({}, { method: 'post', action: '/users' });
        return <><Form method="post" action="/users" /><Form method="get" action="/users" />
          <Form method="post" action="/users?index" /></>;
      }
    `);
    const index = JSON.parse(fs.readFileSync(app.build(), 'utf8'));
    const registered = index.routes.find(route => route.router.id === registration);
    assert.deepEqual([registered.router.index, registered.router.pattern], [true, 'users']);
    const callees = app.query('callees', 'IndexRequests');
    assert.equal((callees.match(/^d1 (?:load|submit) [^\n]+ [A-Z]+ \/users /gm) ?? []).length, 5, fixtureName);
    assert.match(callees, /^# complete:/m);
    const consumers = app.query('api_consumers', explicit ? '/site/users' : '/users');
    assert.match(consumers, /: 6 results /);
    assert.match(consumers, /^# complete:/m);
    const splat = app.query('api_consumers', '/*');
    assert.match(splat, /: 0 results /);
    assert.match(splat, /^# complete:/m);
  }
});

test('pathless index data requests target their path-contributing parent unless ?index is present', t => {
  const app = routerFixture(t, 'react-router-config');
  const write = (file, content) => fs.writeFileSync(path.join(app.root, 'src/ui', file), content);
  write('registry.ts', `
    import { register, index } from './helpers';
    export const registry = [index('home.tsx'), register('users', 'section.tsx', [index('index-form.tsx')])];
  `);
  write('section.tsx', `
    import { Outlet } from 'react-router';
    export function loader() { return null; }
    export default function Users() { return <Outlet />; }
  `);
  write('index-form.tsx', `
    import { useFetcher } from 'react-router';
    export function loader() { return null; }
    export function action() { return null; }
    export default function UsersIndex() {
      const fetcher = useFetcher();
      fetcher.load('.');
      return <p />;
    }
  `);
  write('home.tsx', `
    import { Form } from 'react-router';
    export default function Home() {
      return <><Form method="post" action="/users" />
        <Form method="get" action="/users" />
        <Form method="post" action="/users?index=false" />
        <Form method="post" action="/users?index" /></>;
    }
  `);
  app.build();
  assert.match(app.query('api_consumers', 'route:section'), /: 1 results /);
  const indexConsumers = app.query('api_consumers', 'route:index-form');
  assert.match(indexConsumers, /: 2 results /);
  assert.match(indexConsumers, /GET fetcher.load/);
  const home = app.query('callees', 'Home');
  assert.match(home, /Form: target route has no action \(POST \/users → route:section, src\/ui\/home\.tsx:\d+\)/);
  assert.match(home, /^# complete:/m);
  assert.doesNotMatch(home, /^d1 submit .*POST \/users .*section\.tsx/m);
  assert.match(app.query('callees', 'route:home'), /target route has no action/);
  fs.appendFileSync(path.join(app.root, 'src/ui/home.tsx'), `
    export function QueryIndex({ query }: { query: string }) {
      return <Form method="post" action={\`/users?\${query}\`} />;
    }
  `);
  const dynamic = app.run(['query', 'callees', 'QueryIndex']);
  assert.doesNotMatch(dynamic, /^d1 submit .*section\.tsx/m);
  assert.match(dynamic, /index-form\.tsx[^\n]+\[possible\]/);
  assert.match(dynamic, /^# partial:/m);
});

test('router import coverage follows the answer and excludes assets and generated server imports', t => {
  const app = routerFixture(t, 'react-router-config');
  const rootModule = path.join(app.root, 'src/ui/root.tsx');
  fs.appendFileSync(rootModule, `
    import './styles.css';
    import logo from './logo.svg';
    import font from './font.woff2';
    import raw from './fixture.txt?raw';
    import url from './fixture.bin?url';
    export const assets = [logo, font, raw, url];
  `);
  fs.writeFileSync(path.join(app.root, 'src/ui/broken.ts'), `
    import broken from './missing';
    export function BrokenImporter() { return broken; }
    export function notAServerEntry() { return import('virtual:react-router/server-build'); }
  `);
  const config = path.join(app.root, 'tsconfig.json');
  const tsconfig = JSON.parse(fs.readFileSync(config, 'utf8'));
  tsconfig.include.push('server/**/*');
  fs.writeFileSync(config, JSON.stringify(tsconfig));
  fs.mkdirSync(path.join(app.root, 'server'));
  fs.writeFileSync(path.join(app.root, 'server/index.ts'), `
    export function loadVirtual() { return import('virtual:react-router/server-build'); }
    export function loadGenerated() { return import('../build/server/index.js'); }
    export function loadMissing() { return import('./missing.js'); }
  `);
  const index = JSON.parse(fs.readFileSync(app.build(), 'utf8'));
  const imports = index.router.issues.filter(issue => issue.kind === 'import').map(issue => issue.reason);
  assert.deepEqual(imports.filter(reason => /root\.tsx|server\/index\.ts/.test(reason)), [
    'unresolved dynamic import ./missing.js (server/index.ts:4)'
  ]);
  assert.ok(imports.some(reason => reason.includes('virtual:react-router/server-build (src/ui/broken.ts')));
  assert.match(app.query('wrappers', '/site/panel/left'), /^# complete:/m);
  assert.match(app.query('rename_impact', 'Banner'), /^# complete:/m);
  assert.match(app.query('search', 'Banner'), /^# complete:/m);
  assert.match(app.query('search', 'BrokenImporter'), /^# partial: unresolved import \.\/missing/m);
  assert.match(app.query('callees', 'BrokenImporter'), /^# partial: .*unresolved import \.\/missing/m);
});

test('router refresh notices packages installed after a source-only build', t => {
  const app = routerFixture(t, 'react-router-config');
  fs.appendFileSync(path.join(app.root, 'src/ui/root.tsx'), "\nimport 'router-package';");
  assert.match(app.run(['query', 'wrappers', '/site/panel/left']), /^# partial: unresolved import router-package/m);
  const dependency = path.join(app.root, 'node_modules/router-package');
  fs.mkdirSync(dependency, { recursive: true });
  fs.writeFileSync(path.join(dependency, 'index.d.ts'), 'export {};');
  assert.match(app.run(['query', 'wrappers', '/site/panel/left']), /^# complete:/m);
});

test('router Outlet chains forward through external providers and React context bindings', t => {
  const app = routerFixture(t, 'react-router-config');
  for (const [name, content] of [
    ['react', 'export declare function createContext(value: unknown): any;'],
    ['external-ui', 'export declare function ImageProvider(props: any): any; export declare function Opaque(props: any): any;']
  ]) {
    const dir = path.join(app.root, 'node_modules', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.d.ts'), content);
  }
  const root = path.join(app.root, 'src/ui/root.tsx');
  const content = `
    import { createContext as makeContext } from 'react';
    import { Outlet } from 'react-router';
    import { ImageProvider as Images, Opaque } from 'external-ui';
    const SearchContext = makeContext(null);
    export function Layout({ children }: { children: unknown }) {
      return <SearchContext value={null}>{children}</SearchContext>;
    }
    export default function Root() { return <Images><Outlet /></Images>; }
  `;
  fs.writeFileSync(root, content);
  let output = app.run(['query', 'wrappers', '/site/panel/left']);
  assert.match(output, /SearchContext.*Images/m);
  assert.doesNotMatch(output, /\[possible\]/);
  assert.match(output, /^# complete:/m);
  fs.writeFileSync(root, content.replace('<Images><Outlet /></Images>', '<Opaque><Outlet /></Opaque>'));
  output = app.run(['query', 'wrappers', '/site/panel/left']);
  assert.match(output, /\[possible\]/);
  assert.match(output, /^# partial: outlet forwarding unresolved/m);
});

test('router callees scopes unresolved navigation to the flattened route or visited functions', t => {
  const app = routerFixture(t, 'react-router-config');
  fs.writeFileSync(path.join(app.root, 'src/ui/nav.ts'), `
    import { redirect } from 'react-router';
    export function StaticRedirect(query: URLSearchParams) { return redirect(\`/receiver?\${query}\`); }
    export function DynamicRedirect(url: string) { return redirect(\`\${url}?known=value\`); }
    export function CallsDynamic(url: string) { return DynamicRedirect(url); }
  `);
  fs.writeFileSync(path.join(app.root, 'src/ui/home.tsx'), `
    import { Form, Link } from 'react-router';
    import { CallsDynamic } from './nav';
    export function loader({ request }: { request: Request }) { return CallsDynamic(request.url); }
    export function action() { return null; }
    export default function Home({ search }: { search: string }) {
      return <><Form method="post" /><Link to={{ pathname: '/receiver', search }} /></>;
    }
    export function DynamicLink({ url }: { url: string }) { return <Link to={url} />; }
  `);
  app.build();
  const fixed = app.query('callees', 'StaticRedirect');
  assert.match(fixed, /d1 redirect .* \/receiver /);
  assert.match(fixed, /^# complete:/m);
  assert.match(app.query('callees', 'CallsDynamic'), /^# complete:/m);
  assert.match(app.query('callees', 'CallsDynamic', '--depth', '2'),
    /^# partial: redirect destination or method unresolved .*nav\.ts:4/m);
  assert.match(app.query('callees', 'DynamicLink'), /^# partial: Link destination or method unresolved/m);
  for (const target of ['/site/Case', 'route:case-sensitive']) {
    const route = app.query('callees', target);
    assert.match(route, /^d1 submit .* POST \/Case /m);
    assert.match(route, /^# partial: .*Link destination or method unresolved .*home\.tsx:7.*redirect destination or method unresolved .*nav\.ts:4/m);
    assert.doesNotMatch(route, /home\.tsx:9\)/);
  }
});

test('router impact ignores outgoing render lookups and recognizes bound fetcher forms', t => {
  const app = routerFixture(t, 'react-router-config');
  const pkg = path.join(app.root, 'node_modules/react-router');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'react-router', types: 'index.d.ts' }));
  fs.writeFileSync(path.join(pkg, 'index.d.ts'), `
    export function useFetcher(): { Form: (props: { action: string; method: string }) => any };
  `);
  fs.writeFileSync(path.join(app.root, 'src/ui/registry.ts'), `
    import { register, index } from './helpers';
    export const registry = [index('home.tsx'), register('receiver', 'receiver.ts')];
  `);
  for (const file of ['route.tsx', 'index-form.tsx']) fs.unlinkSync(path.join(app.root, 'src/ui', file));
  fs.writeFileSync(path.join(app.root, 'src/ui/home.tsx'), `
    import { useFetcher } from 'react-router';
    export default function Home() {
      const fetcher = useFetcher();
      return <fetcher.Form action="/receiver" method="post" />;
    }
  `);
  fs.writeFileSync(path.join(app.root, 'src/ui/lookup.tsx'), `
    function Icon() { return <span />; }
    const icons = { Icon };
    export function DynamicLookup({ name }: { name: keyof typeof icons }) {
      const Selected = icons[name];
      return <Selected />;
    }
  `);
  app.build();
  assert.match(app.query('callees', 'Home'), /d1 submit .*POST \/receiver .*fetcher\.Form → action/);
  assert.match(app.query('callees', 'Home'), /^# complete:/m);
  assert.match(app.query('impact', 'src/ui/home.tsx'), /^# complete:/m);
  assert.match(app.query('api_consumers', 'route:receiver'), /^# complete:/m);
  assert.match(app.query('callees', 'DynamicLookup'), /^# partial: component lookup key untraced/m);
  assert.match(app.query('impact', 'DynamicLookup'), /^# complete:/m);
});

test('router useSubmit follows a form passed through an event callback and leaves unknown forms unresolved', t => {
  const app = routerFixture(t, 'react-router-config');
  fs.appendFileSync(path.join(app.root, 'src/ui/root.tsx'), '\nexport function loader() { return null; }\n');
  fs.writeFileSync(path.join(app.root, 'src/ui/home.tsx'), `
    import { Form, useSubmit } from 'react-router';
    declare function useDebounce<T>(callback: T, delay: number): T;
    export default function Home() {
      const submit = useSubmit();
      const handleChange = useDebounce((form: HTMLFormElement) => submit(form), 400);
      return <Form method="GET" action="/receiver" onChange={event => handleChange(event.currentTarget)} />;
    }
    export function UnknownForm(form: HTMLFormElement) {
      const submit = useSubmit();
      submit(form);
    }
    export function Override() {
      const submit = useSubmit();
      return <Form action="/receiver" method="get"
        onChange={event => submit(event.currentTarget, { action: '/guarded', method: 'post' })} />;
    }
  `);
  app.build();
  const home = app.query('callees', 'Home');
  assert.match(home, /^d1 load .*GET \/receiver .*useSubmit → loader.*\[possible\]/m);
  assert.doesNotMatch(home, /GET \/ .*useSubmit/);
  const unknown = app.query('callees', 'UnknownForm');
  assert.doesNotMatch(unknown, /^d1 (?:load|submit) /m);
  assert.match(unknown, /^# partial: .*useSubmit destination or method unresolved/m);
  assert.match(app.query('callees', 'Override', '--depth', '2'), /^d2 submit .*POST \/guarded .*useSubmit → action/m);
});

test('router consumer uncertainty follows the possible destination', t => {
  const app = routerFixture(t, 'react-router-config');
  const file = path.join(app.root, 'src/ui/home.tsx');
  fs.appendFileSync(file, `
    import { Form } from 'react-router';
    export function UncertainMethod({ method }: { method: string }) {
      return <Form action="/guarded" method={method} />;
    }
  `);
  app.build();
  assert.match(app.query('api_consumers', '/site/receiver'), /^# complete:/m);
  assert.match(app.query('api_consumers', '/site/guarded'), /^# partial: Form destination or method unresolved/m);
  fs.appendFileSync(file, `
    export function UncertainDestination({ action }: { action: string }) {
      return <Form method="post" action={action} />;
    }
  `);
  assert.match(app.run(['query', 'api_consumers', '/site/receiver']), /^# partial: Form destination or method unresolved/m);
});

test('runtime route configuration and unresolved imports surface partials through refreshed queries', t => {
  const config = routerFixture(t, 'react-router-config');
  config.build();
  assert.match(config.query('wrappers', '/site/panel/left'), /^# complete:/m);
  fs.appendFileSync(path.join(config.root, 'src/ui/registry.ts'),
    "\nif (process.env.EXTRA) registry.push(register('/dynamic', 'home.tsx'));");
  const dynamic = config.run(['query', 'wrappers', '/site/panel/left']);
  assert.match(dynamic, /page src\/ui\/route.tsx/);
  assert.match(dynamic, /^# complete:/m);
  assert.match(config.query('search', 'dynamic', '--kind', 'route'), /^# partial: route config is mutated at runtime/m);
  assert.match(config.query('wrappers', '/site/dynamic'), /^# partial: route config is mutated at runtime/m);
  fs.appendFileSync(path.join(config.root, 'src/ui/home.tsx'), `
    import { Link } from 'react-router';
    export function DynamicDestination() { return <Link to="/dynamic" />; }
  `);
  assert.match(config.run(['query', 'callees', 'DynamicDestination']), /^# partial: route config is mutated at runtime/m);
  const home = path.join(config.root, 'src/ui/home.tsx');
  fs.writeFileSync(home, fs.readFileSync(home, 'utf8').replace('<article>Home</article>', '<DynamicDestination />'));
  assert.match(config.run(['query', 'callees', 'route:home']), /^# partial: route config is mutated at runtime/m);
  fs.appendFileSync(path.join(config.root, 'src/ui/registry.ts'), '\nif (process.env.REORDER) registry.reverse();');
  assert.match(config.run(['query', 'wrappers', '/site/panel/left']), /^# partial: route config is mutated at runtime/m);
  const remix = routerFixture(t, 'remix-v2');
  fs.appendFileSync(path.join(remix.root, 'web/routes/_auth.login.tsx'), "\nexport { meta } from './missing';");
  remix.build();
  assert.match(remix.query('wrappers', '/login'), /^# partial: .*unresolved (?:route export meta|import \.\/missing)/m);
  fs.writeFileSync(path.join(remix.root, 'remix.config.js'), 'export default { routes() { return []; } };');
  const vite = path.join(remix.root, 'vite.config.ts');
  fs.writeFileSync(vite, fs.readFileSync(vite, 'utf8').replace("ignoredRouteFiles:", "routes() { return []; }, ignoredRouteFiles:"));
  assert.match(remix.run(['query', 'search', '/', '--kind', 'route']), /^# partial: unsupported Remix custom route registry/m);
});
