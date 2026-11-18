const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { generate } = require('./run.cjs');
const { augmentScaffold } = require('./augment-scaffold.cjs');

const externalFixtures = process.env.NEORION_FIXTURES;
const fixtures = path.resolve(externalFixtures ?? path.join(__dirname, 'fixtures'));

function copyFixture(t, name, prefix = '', root = fixtures) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neorion-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const project = path.join(tmp, prefix, name);
  fs.cpSync(path.join(root, name), project, {
    recursive: true,
    filter: file => !['.git', 'node_modules', '.next', 'codebase_graph.md'].includes(path.basename(file))
  });
  return { tmp, project };
}

function validate(graph, project, name) {
  assert.ok(graph.includes(`<codebase name="${name}"`));
  assert.ok(!graph.includes(project));
  assert.doesNotMatch(graph, /<component [^\n]*#(?:GET|HEAD|POST|PUT|DELETE|PATCH|OPTIONS)"/);
  const ids = [...graph.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'graph IDs must be unique');
  for (const [, target] of graph.matchAll(/\b(?:from|to|component)="([^"]+)"/g)) {
    assert.ok(ids.includes(target), `unresolved graph reference ${target}`);
  }
  const sourcePaths = [...graph.matchAll(/<(?:route|component|action) id="(?:route|cmp|action):([^"#]+)(?:#[^"]+)?" /g)]
    .map(match => match[1]);
  const directories = [...graph.matchAll(/<dir path="([^"]+)"/g)].map(match => match[1]);
  for (const file of [...sourcePaths, ...directories]) {
    assert.ok(!path.win32.isAbsolute(file) && !file.startsWith('../'), file);
    assert.ok(fs.existsSync(path.join(project, file)), file);
  }
}

test('taxonomy maps APIs, special routes, hooks and connections', { skip: !externalFixtures }, async t => {
  const { project } = copyFixture(t, 'taxonomy');
  const graph = await generate(project);
  validate(graph, project, 'taxonomy');
  assert.match(graph, /id="route:app\/api\/posts\/route.ts" path="\/api\/posts" type="api" methods="GET POST"/);
  assert.match(graph, /id="route:app\/\(editor\)\/editor\/\[postId\]\/not-found.tsx" path="\/editor\/\[postId\]" type="not-found"/);
  assert.match(graph, /id="cmp:app\/\(docs\)\/layout.tsx#DocsLayout"/);
  assert.match(graph, /id="cmp:app\/\(docs\)\/docs\/layout.tsx#DocsLayout"/);
  assert.match(graph, /<hook id="hook:hooks\/use-mounted.ts#useMounted"/);
  assert.match(graph, /<dir path="hooks" role="react_hooks"/);
  assert.match(graph, /from="cmp:app\/\(docs\)\/layout.tsx#DocsLayout" to="cmp:components\/main-nav.tsx#MainNav" type="renders imports"/);
});

test('commerce maps its revalidation handler and imported components', { skip: !externalFixtures }, async t => {
  const { project } = copyFixture(t, 'commerce');
  const graph = await generate(project);
  validate(graph, project, 'commerce');
  assert.match(graph, /id="route:app\/api\/revalidate\/route.ts" path="\/api\/revalidate" type="api" methods="POST"/);
  assert.match(graph, /id="route:app\/error.tsx" path="\/" type="error"/);
  assert.match(graph, /<hook id="hook:components\/cart\/cart-context.tsx#useCart"/);
  assert.match(graph, /from="cmp:app\/layout.tsx#RootLayout" to="cmp:components\/cart\/cart-context.tsx#CartProvider" type="renders imports"/);
});

test('create-next-app detects src/app and links namespace imports, local JSX and aliased hooks', { skip: !externalFixtures }, async t => {
  const { tmp, project } = copyFixture(t, 'create-next-app', 'apps');
  augmentScaffold(project);
  const graph = await generate(tmp, undefined, [path.join(project, 'tsconfig.json')]);
  validate(graph, project, 'create-next-app');
  assert.match(graph, /<dir path="src\/app" role="routes"/);
  assert.match(graph, /id="route:src\/app\/page.tsx" path="\/" type="page"/);
  assert.match(graph, /id="route:src\/app\/api\/status\/route.ts" path="\/api\/status" type="api" methods="GET POST"/);
  assert.match(graph, /from="cmp:src\/app\/page.tsx#Home" to="cmp:src\/components\/status.tsx#Status" type="renders imports"/);
  assert.match(graph, /from="cmp:src\/components\/status.tsx#Status" to="cmp:src\/components\/status.tsx#LocalLabel" type="renders"/);
  assert.match(graph, /id="cmp:src\/components\/status.tsx#Status" [^\n]* hooks="hook:src\/hooks\/use-status.ts#useStatus"/);

  fs.writeFileSync(path.join(project, 'package.json'), '{}');
  fs.renameSync(project, path.join(tmp, 'fallback-name'));
  const fallback = path.join(tmp, 'fallback-name');
  validate(await generate(fallback), fallback, 'fallback-name');
});

function reviewFixture(t) {
  return copyFixture(t, 'review', '', path.join(__dirname, 'fixtures')).project;
}

test('allowlists dependency specs and emits development dependency names only', async t => {
  const project = reviewFixture(t);
  const pkgFile = path.join(project, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgFile));
  const unsafe = {
    ...pkg.dependencies,
    gitFile: 'git+file:///home/secretuser/private/repo',
    bare: '/home/secretuser/private/lib',
    portal: 'portal:/home/secretuser/private/p',
    bareWindows: 'C:\\Users\\secretuser\\lib',
    bareHome: '~/private/local-lib',
    unc: '\\\\host\\private',
    relative: './private/lib',
    npmPath: 'npm:alias@file:../private',
    workspacePath: 'workspace:../private',
    encodedGit: 'git+https://example.com/repo.git#%2Fprivate',
    gitQuery: 'https://example.com/org/repo.git?dir=/private'
  };
  const safe = {
    semver: '^1.2.0 || >=2.0.0 <3',
    alias: 'npm:@scope/package@~1.0.0',
    workspace: 'workspace:^',
    git: 'git+https://example.com/org/repo.git#feature/branch'
  };
  pkg.dependencies = { ...unsafe, ...safe };
  pkg.devDependencies['dev-only'] = 'file:/home/secretuser';
  fs.writeFileSync(pkgFile, JSON.stringify(pkg));
  const graph = await generate(project);
  for (const name of Object.keys(unsafe)) {
    assert.ok(graph.includes('name="' + name + '" version="[redacted]"'), name);
  }
  for (const [name, spec] of Object.entries(safe)) {
    const escaped = spec.replaceAll('>', '&gt;').replaceAll('<', '&lt;');
    assert.ok(graph.includes('name="' + name + '" version="' + escaped + '"'), name);
  }
  assert.match(graph, /<dev-dependencies names="dev-only" \/>/);
  assert.doesNotMatch(graph, /secretuser|private|name="dev-only"/);
});

test('resolves relative and aliased factory hooks to one project file and omits React hooks', async t => {
  const project = reviewFixture(t);
  const graph = await generate(project);
  validate(graph, project, 'review-fixture');
  const hooks = [...graph.matchAll(/<hook id="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(hooks, ['hook:src/lib/store.ts#useCartStore']);
  assert.equal([...graph.matchAll(/hooks="hook:src\/lib\/store.ts#useCartStore"/g)].length, 2);
});

test('links JSX to the existing component behind a default export and ignores rest props', async t => {
  const graph = await generate(reviewFixture(t));
  assert.match(graph, /from="cmp:src\/app\/\(account\)\/layout.tsx#Layout" to="cmp:src\/components\/panel.tsx#Inner" type="renders imports"/);
  assert.match(graph, /id="cmp:src\/components\/panel.tsx#Inner" isClient="false" props="children"/);
  assert.equal(graph.match(/<component id="cmp:src\/components\/panel.tsx#[^"]+"/g).length, 1);
  assert.match(graph, /<component-group id="cmp:src\/components\/ui" count="1"/);
  assert.match(graph, /from="cmp:src\/components\/panel.tsx#Inner" to="cmp:src\/components\/ui" type="renders imports"/);
});

test('resolves a plain default identifier without duplicating the component or its edges', async t => {
  const project = reviewFixture(t);
  const panel = path.join(project, 'src/components/panel.tsx');
  fs.writeFileSync(panel, fs.readFileSync(panel, 'utf8').replace('memo(Inner)', 'Inner'));
  const graph = await generate(project);
  assert.equal(graph.match(/<component id="cmp:src\/components\/panel.tsx#[^"]+"/g).length, 1);
  assert.match(graph, /to="cmp:src\/components\/panel.tsx#Inner" type="renders imports"/);
  assert.equal(graph.match(/from="cmp:src\/components\/panel.tsx#Inner"/g).length, 1);
});

test('maps Pages API endpoints and reports mixed, Pages-only and App-only routers', async t => {
  const project = reviewFixture(t);
  const mixed = await generate(project);
  assert.match(mixed, /router="mixed"/);
  assert.match(mixed, /id="route:src\/pages\/api\/auth\/\[\.\.\.nextauth\].ts" path="\/api\/auth\/\[\.\.\.nextauth\]" type="api" methods="ALL" isClient="false"/);
  assert.doesNotMatch(mixed, /<component id="cmp:src\/pages\/api/);
  const appDir = path.join(project, 'src', 'app');
  const moved = path.join(project, 'app-disabled');
  fs.renameSync(appDir, moved);
  assert.match(await generate(project), /router="pages"/);
  fs.renameSync(moved, appDir);
  fs.rmSync(path.join(project, 'src', 'pages'), { recursive: true });
  assert.match(await generate(project), /router="app"/);
});

test('reports layout scope, wrapped pages and Next.js special files and actions', async t => {
  const project = reviewFixture(t);
  for (const name of ['robots.ts', 'sitemap.ts', 'opengraph-image.tsx', 'template.tsx', 'default.tsx', 'global-error.tsx']) {
    fs.writeFileSync(path.join(project, 'src', 'app', name), 'export default function Special() {}');
  }
  fs.writeFileSync(path.join(project, 'src/app/help/opengraph-image.png'), '');
  const graph = await generate(project);
  assert.match(graph, /scope="\/\(account\)" type="layout" wraps="route:src\/app\/\(account\)\/page.tsx"/);
  assert.match(graph, /path="\/robots.txt" type="robots"/);
  assert.match(graph, /path="\/sitemap.xml" type="sitemap"/);
  assert.doesNotMatch(graph, /cmp:src\/app\/(?:robots|sitemap|opengraph-image)\./);
  assert.match(graph, /path="\/opengraph-image" type="opengraph-image"/);
  assert.match(graph, /path="\/help\/opengraph-image.png" type="opengraph-image"/);
  for (const type of ['template', 'default', 'global-error']) assert.ok(graph.includes(`type="${type}"`));
  assert.match(graph, /id="action:src\/app\/actions.ts#updateAccount"/);
  assert.match(graph, /id="action:src\/app\/help\/page.tsx#HelpPage.submit"/);
  assert.doesNotMatch(graph, /privateHelper/);
});

test('links used actions through JSX props, callbacks and imports with stable scoped IDs', async t => {
  const project = reviewFixture(t);
  const page = path.join(project, 'src/app/help/page.tsx');
  const source = [
    "import { updateAccount as update } from '../actions'",
    "import * as actions from '../actions'",
    'export default function HelpPage() {',
    "  async function save() { 'use server' }",
    "  async function unused() { 'use server' }",
    "  return <form action={save}><button onClick={() => actions.updateAccount()} />",
    "    <button formAction={update} /><button formAction={async () => { 'use server' }} /></form>",
    '}',
    "export function Other() { const save = async () => { 'use server' }; return <form action={save} /> }"
  ].join('\n');
  fs.writeFileSync(page, source);
  const graph = await generate(project);
  validate(graph, project, 'review-fixture');
  const uses = graph.split('\n').filter(line => line.includes('type="uses-action"')).sort();
  for (const [component, action] of [
    ['HelpPage', 'app/actions.ts#updateAccount'],
    ['HelpPage', 'app/help/page.tsx#HelpPage.save'],
    ['HelpPage', 'app/help/page.tsx#HelpPage.(inline)'],
    ['Other', 'app/help/page.tsx#Other.save']
  ]) {
    assert.ok(uses.includes('    <edge from="cmp:src/app/help/page.tsx#' + component +
      '" to="action:src/' + action + '" type="uses-action" />'), action);
  }
  assert.equal(uses.length, 4);
  fs.writeFileSync(page, '// unrelated edit\n\n' + source);
  assert.deepEqual((await generate(project)).split('\n').filter(line =>
    line.includes('<action ') || line.includes('type="uses-action"')), graph.split('\n').filter(line =>
    line.includes('<action ') || line.includes('type="uses-action"')));
});
