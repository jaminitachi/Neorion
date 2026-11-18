const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { generate } = require('./run.cjs');
const { augmentScaffold } = require('./augment-scaffold.cjs');

const fixtures = path.resolve(process.env.NEORION_FIXTURES ?? path.join(__dirname, '.fixtures'));

function copyFixture(t, name, prefix = '') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neorion-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const project = path.join(tmp, prefix, name);
  fs.cpSync(path.join(fixtures, name), project, {
    recursive: true,
    filter: file => !['.git', 'node_modules', '.next', 'codebase_graph.md'].includes(path.basename(file))
  });
  return { tmp, project };
}

function validate(graph, project, name) {
  assert.ok(graph.includes(`<codebase name="${name}"`));
  assert.ok(!graph.includes(project));
  assert.doesNotMatch(graph, /<component [^\n]* name="(?:GET|HEAD|POST|PUT|DELETE|PATCH|OPTIONS)"/);
  const ids = [...graph.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'graph IDs must be unique');
  for (const [, target] of graph.matchAll(/\b(?:from|to|component)="([^"]+)"/g)) {
    assert.ok(ids.includes(target), `unresolved graph reference ${target}`);
  }
  const files = [
    ...graph.matchAll(/<route [^\n]* file="([^"]+)"/g),
    ...graph.matchAll(/<(?:component|hook|dir) [^\n]* path="([^"]+)"/g)
  ];
  for (const [, file] of files) {
    assert.ok(!path.win32.isAbsolute(file) && !file.startsWith('../'), file);
    assert.ok(fs.existsSync(path.join(project, file)), file);
  }
}

test('taxonomy maps APIs, special routes, hooks and connections', async t => {
  const { project } = copyFixture(t, 'taxonomy');
  const graph = await generate(project);
  validate(graph, project, 'taxonomy');
  assert.match(graph, /path="\/api\/posts" file="app\/api\/posts\/route.ts" type="api" methods="GET POST"/);
  assert.match(graph, /path="\/editor\/\[postId\]" file="app\/\(editor\)\/editor\/\[postId\]\/not-found.tsx" type="not-found"/);
  assert.match(graph, /id="cmp:app\/\(docs\)\/layout.tsx#DocsLayout"/);
  assert.match(graph, /id="cmp:app\/\(docs\)\/docs\/layout.tsx#DocsLayout"/);
  assert.match(graph, /<hook id="hook:hooks\/use-mounted.ts#useMounted"/);
  assert.match(graph, /<dir path="hooks" role="react_hooks"/);
  assert.match(graph, /from="cmp:app\/\(docs\)\/layout.tsx#DocsLayout" to="cmp:components\/main-nav.tsx#MainNav" type="renders imports"/);
});

test('commerce maps its revalidation handler and imported components', async t => {
  const { project } = copyFixture(t, 'commerce');
  const graph = await generate(project);
  validate(graph, project, 'commerce');
  assert.match(graph, /path="\/api\/revalidate" file="app\/api\/revalidate\/route.ts" type="api" methods="POST"/);
  assert.match(graph, /file="app\/error.tsx" type="error"/);
  assert.match(graph, /<hook id="hook:components\/cart\/cart-context.tsx#useCart"/);
  assert.match(graph, /from="cmp:app\/layout.tsx#RootLayout" to="cmp:components\/cart\/cart-context.tsx#CartProvider" type="renders imports"/);
});

test('create-next-app detects src/app and links namespace imports, local JSX and aliased hooks', async t => {
  const { tmp, project } = copyFixture(t, 'create-next-app', 'apps');
  augmentScaffold(project);
  const graph = await generate(tmp, undefined, [path.join(project, 'tsconfig.json')]);
  validate(graph, project, 'create-next-app');
  assert.match(graph, /<dir path="src\/app" role="routes"/);
  assert.match(graph, /file="src\/app\/page.tsx" type="page"/);
  assert.match(graph, /file="src\/app\/api\/status\/route.ts" type="api" methods="GET POST"/);
  assert.match(graph, /from="cmp:src\/app\/page.tsx#Home" to="cmp:src\/components\/status.tsx#Status" type="renders imports"/);
  assert.match(graph, /from="cmp:src\/components\/status.tsx#Status" to="cmp:src\/components\/status.tsx#LocalLabel" type="renders"/);
  assert.match(graph, /name="Status" [^\n]* hooks="hook:src\/hooks\/use-status.ts#useStatus"/);

  fs.writeFileSync(path.join(project, 'package.json'), '{}');
  fs.renameSync(project, path.join(tmp, 'fallback-name'));
  const fallback = path.join(tmp, 'fallback-name');
  validate(await generate(fallback), fallback, 'fallback-name');
});
