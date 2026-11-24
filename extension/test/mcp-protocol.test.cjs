const { cachePath, indexFile } = require('./workspace-cache.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { generate } = require('./run.cjs');
const { openMcp } = require('./mcp-helpers.cjs');

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neorion-protocol-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function snapshot(root) {
  const entries = [];
  const visit = relative => {
    const file = path.join(root, relative);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) entries.push([relative, fs.readlinkSync(file)]);
    else if (stat.isDirectory()) {
      entries.push([relative, '/']);
      for (const child of fs.readdirSync(file).sort()) visit(path.join(relative, child));
    } else entries.push([relative, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]);
  };
  visit('');
  return entries;
}

test('P1–P3 real stdio initializes, advertises exact schemas and only emits JSON-RPC without project writes', async t => {
  const root = temporary(t);
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}');
  fs.writeFileSync(path.join(root, 'example.ts'), 'export const Example = 1;');
  await generate(root);
  assert.deepEqual(snapshot(root).map(([file]) => file), ['', 'example.ts', 'tsconfig.json']);
  try {
    const files = execFileSync('rg', ['--files', '--hidden'], { cwd: root, encoding: 'utf8' });
    assert.deepEqual(files.trim().split('\n').sort(), ['example.ts', 'tsconfig.json']);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const before = snapshot(root);
  const client = await openMcp(t, root);
  assert.deepEqual((await client.request('tools/list')).tools, require('./goldens/mcp-tools.json'));
  const result = await client.request('tools/call', {
    name: 'neorion_query', arguments: { kind: 'search', target: 'Example' }
  });
  assert.match(result.content[0].text, /constant example.ts:1#Example/);
  assert.match(result.content[0].text, /# complete: indexed name and path matches/);
  assert.equal(client.stdout.length, 3);
  assert.ok(client.stdout.every(line => JSON.parse(line).jsonrpc === '2.0'));
  await client.close();
  assert.equal(client.stderr(), '');
  assert.deepEqual(snapshot(root), before);
});

const benchRepos = process.env.NEORION_BENCH_REPOS;
test('P4 Formbricks index and five real stdio calls meet size and latency targets', { skip: !benchRepos, timeout: 300_000 }, async t => {
  const root = temporary(t);
  const repo = path.join(benchRepos, 'formbricks');
  const archive = path.join(temporary(t), 'formbricks.tar');
  execFileSync('git', ['-C', repo, 'archive', '--output', archive, 'HEAD:apps/web']);
  execFileSync('tar', ['-xf', archive, '-C', root]);
  await generate(root);
  const size = fs.statSync(cachePath(root, indexFile)).size;
  assert.ok(size <= 15_000_000, `${size} bytes`);
  const client = await openMcp(t, root, process.env.NEORION_MCP_ENTRY);
  const queries = {
    who_renders: { component: 'modules/ui/components/chart/index.tsx#ChartTooltip' },
    wrappers: { route: '/workspaces/[workspaceId]/contacts/[contactId]' },
    rename_impact: { symbol: 'lib/googleSheet/service.ts#writeData' },
    api_consumers: { route: '/api/v3/surveys/[surveyId]/visibility' },
    search: { text: 'ChartTooltip' }
  };
  const timings = [];
  for (let run = 0; run < 10; run++) {
    for (const [tool, args] of Object.entries(queries)) {
      const start = performance.now();
      const result = await client.text(tool, args);
      timings.push(performance.now() - start);
      const bytes = Buffer.byteLength(result);
      assert.ok(bytes <= 6000 && result.split('\n').every(line => Buffer.byteLength(line) <= 400));
      assert.doesNotMatch(result, / : 0 results|^# ambiguous|stale \d+/);
      if (run === 0 && process.env.NEORION_MCP_SMOKE) t.diagnostic(`${tool} (${bytes} bytes)\n${result}`);
    }
  }
  timings.sort((a, b) => a - b);
  const p95 = timings[Math.ceil(timings.length * 0.95) - 1];
  t.diagnostic(`Formbricks index: ${size} bytes, initialize: ${client.startup.toFixed(1)} ms, query p95: ${p95.toFixed(1)} ms`);
  assert.ok(client.startup <= 500, `Initialize ${client.startup} ms`);
  assert.ok(p95 <= 100, `p95 ${p95} ms`);
  assert.equal(client.stderr(), '');
});
