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
    /# partial: tRPC client proxy not traced/]) assert.match(impact, evidence);
  assert.doesNotMatch(impact, /api POST/);
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
  assert.match(callees, /call .*normalize/);
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
  const indexFile = build();
  const impact = query('impact', 'cn');
  assert.match(impact, /hub collapsed/);
  assert.match(impact, /200 callers in 1 files/);
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
