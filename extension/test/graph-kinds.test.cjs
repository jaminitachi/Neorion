const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
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
    assert.equal(query(kind, target, ...flags), output);
    assert.equal(await mcp.text('query', { kind, target, ...options }), output);
    assert.equal(stable(reversed.query(kind, target, ...flags)), stable(output));
    assert.ok(Buffer.byteLength(output.split('\n').slice(1).join('\n')) <= 6000);
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
  assert.match(targetAction, /depth 5 \(limit 3 \+ renders\/events\)/);
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

test('path gives the shortest directed chain from a page, symbol, or layout', { timeout: 30_000 }, async t => {
  const { root, env, query, build } = fixture(t);
  build();
  const directly = query('path', '/items', 'createItem');
  assert.match(directly, /: 3 hops /);
  assert.match(directly, /^0 route \/items.* Items$/m);
  assert.match(directly, /^1 render .*CreateItem \[cond\]$/m);
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
  assert.match(total, /^call app\/trpc-cache\/page\.tsx:\d+ CachePage \(fetch\)$/m);
  assert.match(total, /^call app\/trpc-cache\/page\.tsx:\d+ CachePage \(ensureData\)$/m);
  assert.match(query('api_consumers', target, '--limit', '1'), /^call app\/trpc-cache\/page\.tsx:\d+ CachePage \(fetch\)$/m);
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
  assert.match(changes('--staged'), /3 files, 0 symbols, 2 routes/);
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

  const impact = query('impact', 'publishPrimary', '--depth', '6');
  assert.match(impact, /^page \/primary\s/m);
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
  fs.writeFileSync(actions, fs.readFileSync(actions, 'utf8').replace('publishPrimary() {}', 'publishPrimary() { return true; }'));
  build();
  const changes = query('changes', '--unstaged', '--depth', '6');
  assert.match(changes, /page \/primary\s/);
  assert.doesNotMatch(changes, /page \/secondary\s/);

  const capture = query('path', '/jobs', 'captureNode');
  assert.match(capture, /makeSnapshot \(onClick <button Snapshot>\)/);
  assert.match(capture, /createCapture .*useJobControls > useJobStore > bindings/);
  assert.match(capture, /callback ref ui\/jobs\.tsx:\d+ \(key key\)/);
  assert.match(capture, /argument refs\.get\(key\)/);
  assert.match(query('path', 'useJobStore', 'captureNode'), /no directed path/);

  const sync = query('api_consumers', 'syncJobs');
  assert.match(sync, /call .* start\nevent .*Start jobs/);
  assert.match(sync, /call .* retry\nevent .*Retry job/);
  assert.match(sync, /page \/jobs\s/);
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
    const result = spawnSync(process.execPath, [entry, ...args], { cwd, env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const overview = /^Overview: (.+)$/m.exec(run('graph'))[1];
  const indexFile = path.join(path.dirname(overview), indexPath);
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  assert.deepEqual(index.routes.find(route => route.url === '/api/fixture').methods, ['POST']);
  assert.deepEqual(index.routes.find(route => route.url === '/api/alias').methods, ['ALL']);
  assert.ok(index.pagesWorkspaceInputs.files.includes('packages/dispatch/handler.ts'));
  assert.ok(index.pagesWorkspaceInputs.files.every(file => !file.includes('packages/unused/')));
  assert.ok(Object.keys(index.files).every(file => !file.startsWith('../')));
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
