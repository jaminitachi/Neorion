const { cachePath } = require('./workspace-cache.cjs');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');
const { count, assertOverviewLinks, overviewBudget } = require('./graph-output.cjs');
const { generate, visualize, register } = require('./run.cjs');
const { augmentScaffold } = require('./augment-scaffold.cjs');

const externalFixtures = process.env.NEORION_FIXTURES;
if (process.env.CI && !externalFixtures) {
  throw new Error('Set NEORION_FIXTURES to the directory created by test/fetch-fixtures.cjs in CI');
}
const fixtures = path.resolve(externalFixtures ?? path.join(__dirname, 'fixtures'));

function copyFixture(t, name, prefix = '', root = fixtures) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neorion-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const project = path.join(tmp, prefix, name);
  fs.cpSync(path.join(root, name), project, {
    recursive: true,
    filter: file => !['.git', 'node_modules', '.next', '.neorion', 'codebase_graph.md'].includes(path.basename(file)) &&
      path.relative(path.join(root, name), file) !== 'neorion/graph'
  });
  return { tmp, project };
}

function readMap(project, overview, name) {
  assert.ok(overview.startsWith('# ' + name + ' architecture') ||
    overview.split('\n').includes('# ' + name + ' architecture (mixed router)'));
  const root = cachePath(project, 'neorion/graph');
  const details = fs.readdirSync(root).filter(file => file.endsWith('.md'));
  assertOverviewLinks(project, overview);
  const files = Object.fromEntries(details.map(file => [file, fs.readFileSync(path.join(root, file), 'utf8')]));
  for (const [file, detail] of Object.entries(files)) {
    assert.ok(count(detail) <= 3000, file);
    assert.ok(!detail.includes(project));
    assert.doesNotMatch(detail, /:\s+(?:GET|HEAD|POST|PUT|DELETE|PATCH|OPTIONS)\(/);
    if (/^\+(?:dependencies|areas)(?:\+\d+)?\.md$/.test(file) || file.startsWith('+reverse-')) continue;
    let directory;
    for (const line of detail.split('\n')) {
      if (/^(rendered|rename|wrap|fetch) /.test(line)) continue;
      if (line.endsWith('/') && !line.startsWith(' ')) directory = line;
      if (line.startsWith('  ') && line.includes(': ')) {
        const basename = line.trim().split(': ')[0].replace(/ \(c\)$/, '');
        assert.ok(fs.existsSync(path.join(project, directory, basename)), `${directory}${basename}`);
      }
    }
  }
  return files;
}

test('graph domain colors are deterministic and adapt to the webview theme', t => {
  const { outputFiles } = require('esbuild').buildSync({
    entryPoints: [path.join(__dirname, '../src/core/visualizers/GraphVisualizer.ts')],
    bundle: true,
    platform: 'node',
    external: ['vscode'],
    write: false
  });
  const visualizerModule = { exports: {} };
  const mockRequire = name => name === 'vscode' ? { Uri: { joinPath: path.join } } : require(name);
  new Function('module', 'require', outputFiles[0].text)(visualizerModule, mockRequire);
  const visualizer = Object.create(visualizerModule.exports.GraphVisualizer.prototype);
  visualizer._extensionUri = path.resolve(__dirname, '..');
  const webview = { asWebviewUri: pathToFileURL, cspSource: 'file:' };
  const domains = ['api', 'auth', 'billing', 'dashboard', 'docs', 'editor', 'hooks',
    'marketing', 'pages', 'profile', 'reports', 'search', 'settings', 'other', 'shared-ui'];
  const render = names => {
    const graph = {
      routes: names.map(domain => ({
        id: domain, path: '/' + domain, file: 'app/' + domain + '/page.tsx', type: 'page', domain
      })),
      components: [], actions: [], edges: []
    };
    return visualizer._getHtmlForWebview(webview, graph);
  };
  const groupsFor = html => {
    const [, payload] = /const rawData = "([^"]+)"/.exec(html);
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8')).groupsConfig;
  };
  const html = render(domains);
  const groups = groupsFor(html);
  assert.deepEqual(groups, groupsFor(render([...domains].reverse())));
  const fills = Object.values(groups).map(color => color.toLowerCase());
  assert.equal(new Set(fills).size, domains.length);

  if (process.env.NEORION_BROWSER_PYTHON) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neorion-webview-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const themedHtml = html.replace('</head>', `<style>
      body.vscode-light {
        --vscode-editor-background: #fff;
        --vscode-editor-foreground: #333;
      }
    </style></head>`).replace(/<script nonce="[^"]+">/, tag => tag + `
      window.acquireVsCodeApi = () => ({ postMessage() {} });
      document.body.className = 'vscode-' + new URLSearchParams(location.search).get('theme');
    `);
    const fixture = path.join(directory, 'theme.html');
    fs.writeFileSync(fixture, themedHtml);
    execFileSync(process.env.NEORION_BROWSER_PYTHON, [path.join(__dirname, 'graph-theme-smoke.py'), fixture],
      { stdio: 'inherit', timeout: 60_000 });
  }
});

test('taxonomy maps APIs, special routes, duplicate component names, and hooks', { skip: !externalFixtures }, async t => {
  const { project } = copyFixture(t, 'taxonomy');
  const overview = await generate(project);
  const details = readMap(project, overview, 'taxonomy');
  assert.match(overview, /posts  route.ts\[GET POST\]/);
  assert.match(overview, /\[postId\].*not-found.tsx\(not-found\)/);
  assert.match(details['app~(docs).md'], /layout.tsx: DocsLayout.*>.*MainNav/);
  assert.equal((details['app~(docs).md'].match(/layout.tsx: DocsLayout/g) ?? []).length, 2);
  assert.match(overview, /hooks\/use-mounted.ts: useMounted/);
  assert.match(details['components~ui.md'], /badge.tsx: Badge\(className,variant\)/);
  assert.match(details['components~ui.md'], /button.tsx: Button\(className,variant,size\)/);
  assert.ok(count(overview) <= 1000);
  const areaTotal = Object.entries(details).filter(([file]) => !file.startsWith('+reverse-'))
    .reduce((total, [, detail]) => total + count(detail), 0);
  assert.ok(areaTotal <= 4500, `taxonomy area details: ${areaTotal}`);
  assert.ok(Object.values(details).reduce((total, detail) => total + count(detail), 0) <= 5000);
  const facts = Object.values(details).join('\n');
  for (const kind of ['wrap', 'fetch', 'rendered', 'rename']) assert.match(facts, new RegExp(`^${kind} `, 'm'));
  assert.match(overview, /Detail budget abbreviates .*lists/);
});

test('commerce maps its revalidation handler and distinguishes render and import edges', { skip: !externalFixtures }, async t => {
  const { project } = copyFixture(t, 'commerce');
  const overview = await generate(project);
  const details = readMap(project, overview, 'commerce');
  assert.match(overview, /api\/revalidate  route.ts\[POST\]/);
  assert.match(overview, /error.tsx\(error\)/);
  assert.match(overview, /components\/cart\/cart-context.tsx: useCart/);
  assert.match(details['components~layout.md'], /product-grid-items.tsx:.*>.*GridItem\[render\].*Grid\[import\]/);
  assert.match(details['app.md'], /layout.tsx:.*>.*CartProvider\b/);
  assert.ok(count(overview) <= 800);
});

test('create-next-app detects src/app and links namespace imports, local JSX and aliased hooks', { skip: !externalFixtures }, async t => {
  const { tmp, project } = copyFixture(t, 'create-next-app', 'apps');
  augmentScaffold(project);
  const overview = await generate(tmp, undefined, [path.join(project, 'tsconfig.json')]);
  const details = readMap(project, overview, 'create-next-app');
  assert.match(overview, /src\/app.*page.tsx=Home/);
  assert.match(overview, /api\/status  route.ts\[GET POST\]/);
  assert.match(details['src~app.md'], /page.tsx: Home.*> Status/);
  assert.match(details['src~components.md'], /status.tsx \(c\):.*Status h:useStatus.*Status > LocalLabel\[render\]/);
  assert.ok(count(overview) <= 500);

  fs.writeFileSync(path.join(project, 'package.json'), '{}');
  fs.renameSync(project, path.join(tmp, 'fallback-name'));
  const fallback = path.join(tmp, 'fallback-name');
  readMap(fallback, await generate(fallback), 'fallback-name');
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
    next: 'latest',
    canary: 'canary',
    taggedAlias: 'npm:@scope/package@next',
    nextTag: 'next',
    beta: 'beta',
    workspace: 'workspace:^',
    git: 'git+https://example.com/org/repo.git#feature/branch'
  };
  pkg.dependencies = { ...unsafe, ...safe };
  pkg.devDependencies['dev-only'] = 'file:/home/secretuser';
  fs.writeFileSync(pkgFile, JSON.stringify(pkg));
  const overview = await generate(project);
  const graph = readMap(project, overview, 'review-fixture')['+dependencies.md'];
  for (const name of Object.keys(unsafe)) assert.ok(graph.includes(name + ' [redacted]'), name);
  for (const [name, spec] of Object.entries(safe)) assert.ok(graph.includes(name + ' ' + spec + '\n'), name);
  assert.match(graph, /dev dev-only$/m);
  assert.doesNotMatch(graph, /secretuser|private/);
});

test('resolves factory hooks across aliases and omits React hooks', async t => {
  const project = reviewFixture(t);
  const overview = await generate(project);
  const details = readMap(project, overview, 'review-fixture');
  assert.equal([...overview.matchAll(/src\/lib\/store.ts: useCartStore/g)].length, 1);
  assert.equal(Object.values(details).join('\n').match(/h:useCartStore/g).length, 2);
  assert.doesNotMatch(Object.values(details).join('\n'), /useState/);
});

for (const [label, replacement, name] of [
  ['memo', 'export default memo(Inner)', 'Inner'],
  ['plain default identifier', 'export default Inner', 'Inner'],
  ['named memo wrapper', 'const Panel = memo(Inner); export default Panel', 'Panel']
]) {
  test(`resolves ${label} to one component with its props and edges`, async t => {
    const project = reviewFixture(t);
    const panel = path.join(project, 'src/components/panel.tsx');
    fs.writeFileSync(panel, fs.readFileSync(panel, 'utf8').replace('export default memo(Inner)', replacement));
    const details = readMap(project, await generate(project), 'review-fixture');
    assert.equal(details['src~components.md'].split('panel.tsx:').length, 2);
    assert.ok(details['src~components.md'].includes(`panel.tsx: ${name}(children) h:useCartStore | +1 UI/icon targets`));
    assert.ok(details['src~app~(account).md'].includes(`> ${name}\n`));
    assert.match(details['src~components~ui.md'], /button.tsx: Button\(children\)/);
    assert.doesNotMatch(details['src~components.md'], /rest|default|Button/);
  });
}

test('maps Pages API endpoints and reports mixed, Pages-only and App-only routers', async t => {
  const project = reviewFixture(t);
  const mixed = await generate(project);
  assert.match(mixed, /\(mixed router\)/);
  assert.match(mixed, /pages\/api\/auth  \[\.\.\.nextauth\].ts\[\*\]/);
  const details = readMap(project, mixed, 'review-fixture');
  assert.match(details['src~pages~api.md'], /\[\.\.\.nextauth\].ts: route/);
  const appDir = path.join(project, 'src', 'app');
  const moved = path.join(project, 'app-disabled');
  fs.renameSync(appDir, moved);
  assert.match(await generate(project), /\(pages router\)/);
  fs.renameSync(moved, appDir);
  fs.rmSync(path.join(project, 'src', 'pages'), { recursive: true });
  assert.match(await generate(project), /\(app router\)/);
});

test('reports layout scope, wrapped pages and Next.js special files and actions', async t => {
  const project = reviewFixture(t);
  for (const name of ['robots.ts', 'sitemap.ts', 'opengraph-image.tsx', 'template.tsx', 'default.tsx', 'global-error.tsx']) {
    fs.writeFileSync(path.join(project, 'src', 'app', name), 'export default function Special() {}');
  }
  fs.writeFileSync(path.join(project, 'src/app/help/opengraph-image.png'), '');
  const graph = await generate(project);
  assert.match(graph, /\(account\)  layout.tsx\(L\)=Layout  page.tsx=AccountPage/);
  for (const name of ['robots.txt', 'sitemap.xml', 'opengraph-image', 'help/opengraph-image.png']) {
    assert.ok(graph.includes('→ /' + name), name);
  }
  for (const type of ['template', 'default', 'global-error']) assert.ok(graph.includes(`(${type})`));
  const details = readMap(project, graph, 'review-fixture');
  assert.doesNotMatch(details['src~app.md'], /(?:robots|sitemap|opengraph-image)\.tsx?: Special/);
  assert.match(graph, /src\/app\/actions.ts#updateAccount/);
  assert.match(graph, /src\/app\/help\/page.tsx#HelpPage.submit/);
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
  const details = readMap(project, graph, 'review-fixture');
  const help = details['src~app~help.md'];
  assert.match(help, /HelpPage > .*updateAccount\[action\].*HelpPage.\(inline\)\[action\].*HelpPage.save\[action\]/);
  assert.match(help, /Other > .*Other.save\[action\]/);
  assert.equal([...help.matchAll(/\[action\]/g)].length, 4);
  fs.writeFileSync(page, '// unrelated edit\n\n' + source);
  assert.equal(await generate(project), graph);
  assert.equal(readMap(project, graph, 'review-fixture')['src~app~help.md'], help);
});

test('keeps UI props, project hooks, outgoing domain edges and action calls while counting UI targets', async t => {
  const project = reviewFixture(t);
  const ui = path.join(project, 'src/components/ui');
  fs.mkdirSync(path.join(ui, 'forms'));
  fs.writeFileSync(path.join(project, 'src/components/banner.tsx'), 'export const Banner = () => <aside />');
  fs.writeFileSync(path.join(ui, 'toaster.tsx'), [
    "import { Banner } from '../banner'",
    "import { useCartStore } from '../../lib/store'",
    'export function Toaster() { useCartStore(); return <Banner /> }',
    'export function ToastTitle() { return <span /> }'
  ].join('\n'));
  fs.writeFileSync(path.join(ui, 'forms/checkout-form.tsx'), [
    "import { updateAccount } from '../../../app/actions'",
    'export function CheckoutForm({ amount }) { return <form action={updateAccount}>{amount}</form> }'
  ].join('\n'));
  fs.writeFileSync(path.join(ui, 'surface.tsx'), [
    "import { Button } from './button'",
    "import { Banner } from '../banner'",
    'export function Surface({ title }) { return <Button>{title ?? Banner.name}</Button> }'
  ].join('\n'));
  fs.writeFileSync(path.join(ui, 'toast-region.tsx'), [
    "import { Toaster } from './toaster'",
    'export function ToastRegion() { return <Toaster /> }'
  ].join('\n'));
  fs.writeFileSync(path.join(ui, 'radix.tsx'), [
    '"use client"',
    "import * as Radix from '@radix-ui/react-dialog'",
    'export const Root = Radix.Root',
    'export function Dialog({ open }) { return <Root open={open}><Radix.Content /></Root> }'
  ].join('\n'));
  const graph = await generate(project);
  const details = readMap(project, graph, 'review-fixture');
  const primitives = details['src~components~ui.md'];
  assert.match(primitives, /radix.tsx \(c\): Dialog\(open\) \| Root.*\+1 UI\/icon targets/);
  assert.match(primitives, /surface.tsx: Surface\(title\).*Banner\[import\].*\+1 UI\/icon targets/);
  assert.match(primitives, /toaster.tsx: Toaster h:useCartStore \| ToastTitle \| Toaster > Banner/);
  assert.match(primitives, /checkout-form.tsx: CheckoutForm\(amount\).*updateAccount\[action\]/);
  assert.match(primitives, /toast-region.tsx: ToastRegion \| \+1 UI\/icon targets/);
});

test('keeps props for conditional primitive wrappers', async t => {
  const project = reviewFixture(t);
  fs.writeFileSync(path.join(project, 'src/components/ui/button.tsx'), [
    "import { Slot } from '@radix-ui/react-slot'",
    'export function Button({ asChild, children }) {',
    '  const Comp = asChild ? Slot : "button"',
    '  return <Comp>{children}</Comp>',
    '}'
  ].join('\n'));
  const details = readMap(project, await generate(project), 'review-fixture');
  assert.match(details['src~components~ui.md'], /button.tsx: Button\(asChild,children\)/);
});

test('reports aliased and namespace action calls outside component bodies', async t => {
  const project = reviewFixture(t);
  fs.writeFileSync(path.join(project, 'src/lib/submit.ts'), [
    "import { updateAccount as update } from '../app/actions'",
    "import * as actions from '../app/actions'",
    'export async function submit() { await update(); await actions.updateAccount(); }'
  ].join('\n'));
  const overview = await generate(project);
  const details = readMap(project, overview, 'review-fixture');
  assert.match(overview, /src\/lib\/submit.ts > src\/app\/actions.ts#updateAccount/);
  assert.match(details['src~lib.md'], /submit.ts: > src\/app\/actions.ts#updateAccount\[action\]$/m);
  const { nodes, edges } = await visualize(project);
  assert.ok(nodes.some(node => node.id === 'file:src/lib/submit.ts' && node.path === 'src/lib/submit.ts'));
  assert.ok(edges.some(edge => edge.from === 'file:src/lib/submit.ts' &&
    edge.to === 'action:src/app/actions.ts#updateAccount' && edge.title === 'uses-action'));
});

test('detects Pages API equality guards and switches on the exported handler request', async t => {
  const project = reviewFixture(t);
  const directory = path.join(project, 'src/pages/api');
  fs.writeFileSync(path.join(directory, 'guard.ts'), `
    const handler = (request, res) => {
      if (request.method !== 'POST') return res.status(405).end();
      if (res.method === 'HEAD') throw new Error();
      return res.end();
    };
    export default handler;
  `);
  fs.writeFileSync(path.join(directory, 'switch.ts'), `
    export default function handler(req, res) {
      switch (req.method) {
        case 'PATCH': case 'DELETE': return res.end();
        default: return res.status(405).end();
      }
    }
  `);
  fs.writeFileSync(path.join(directory, 'preflight.ts'), `
    export default function handler(req, res) {
      if (req.method === 'OPTIONS') return res.end();
      return tusServer.handle(req, res);
    }
  `);
  fs.writeFileSync(path.join(directory, 'wrapped.ts'), `
    async function authenticate(req) {
      if (!req.headers.token) return { status: 401 };
      return { authenticated: true };
    }
    function wrap(handler) {
      return async (req, res) => {
        const auth = await authenticate(req);
        if ('status' in auth) {
          res.status(auth.status).json({ error: 'Unauthorized' });
          return;
        }
        await handler({ ...auth, req, res });
      };
    }
    export default wrap(({ req: request, res }) => {
      if (request.method === 'GET') return res.end();
      if (request.method === 'DELETE') return res.end();
      return res.status(405).end();
    });
  `);
  const overview = await generate(project);
  assert.match(overview, /preflight.ts\[\*\]/);
  assert.match(overview, /wrapped.ts\[GET DELETE\]/);
  assert.match(overview, /guard.ts\[POST\]/);
  assert.match(overview, /switch.ts\[DELETE PATCH\]/);
  assert.match(overview, /\[\.\.\.nextauth\].ts\[\*\]/);
});

test('enforces the tracked file-list budget and partitions oversized areas without losing route entries', async t => {
  const project = reviewFixture(t);
  const { execFileSync } = require('node:child_process');
  const git = (...args) => execFileSync('git', args, { cwd: project, encoding: 'utf8' });
  const api = path.join(project, 'src/pages/api');
  for (let i = 0; i < 1800; i++) {
    const file = path.join(api, `customer-analytics-archive-record-${i}.ts`);
    fs.writeFileSync(file, "export default (req, res) => req.method === 'GET' ? res.end() : res.status(405).end()");
  }
  git('init', '-q');
  git('add', '.');
  const list = git('ls-files', '-z').split('\0').filter(Boolean).join('\n') + '\n';
  const budget = overviewBudget(list);
  assert.ok(budget > 1500);
  const overview = await generate(project);
  assert.ok(count(overview) <= budget);
  assert.match(overview, /^Overview abbreviates .*Routes/);
  assert.match(overview, /browse \[all details\]/);
  assertOverviewLinks(project, overview);
  const directory = cachePath(project, 'neorion/graph');
  const shards = fs.readdirSync(directory).filter(file => file.startsWith('src~pages~api'));
  assert.ok(shards.length > 1);
  const contents = shards.map(file => fs.readFileSync(path.join(directory, file), 'utf8'));
  for (const text of contents) assert.ok(count(text) <= 3000);
  assert.equal(contents.join('').match(/: route customer-analytics-archive-record-\d+.ts\[GET\]/g).length, 1800);

  fs.writeFileSync(path.join(directory, 'notes.md'), 'handwritten');
  fs.rmSync(api, { recursive: true });
  await generate(project);
  assert.ok(shards.every(file => !fs.existsSync(path.join(directory, file))));
  assert.equal(fs.readFileSync(path.join(directory, 'notes.md'), 'utf8'), 'handwritten');
});

function addOverviewSource(project, file, source = 'export default function Page() { return null; }') {
  const target = path.join(project, 'src', file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
}

function overviewRows(overview, heading) {
  return (overview.split(`\n## ${heading}\n\n`)[1] ?? '').split('\n## ')[0].split('\n')
    .filter(row => row && !row.startsWith('~~~'));
}

test('preserves the HEAD plain overview byte for byte when all routes fit', async t => {
  const overview = await generate(reviewFixture(t));
  assert.equal(overview, fs.readFileSync(path.join(__dirname, 'goldens/overview-plain.md'), 'utf8'));
});

test('keeps every route row when areas and server actions compete for overview space', async t => {
  const project = reviewFixture(t);
  const areaNames = Array.from({ length: 32 }, (_, i) => `(long-generated-area-name-${i})`);
  for (const name of areaNames) addOverviewSource(project, `app/${name}/page.tsx`);
  const actionDefinitions = Array.from({ length: 60 }, (_, i) => `export async function updateRecord${i}() {}`);
  addOverviewSource(project, 'lib/generated-actions.ts', ['"use server";', ...actionDefinitions].join('\n'));

  const overview = await generate(project);
  const rows = new Set(overviewRows(overview, 'Routes').map(row => row.trimStart()));
  for (const name of areaNames) assert.ok(rows.has(`${name}  page.tsx=Page`), name);
  assert.doesNotMatch(overview, /^Overview abbreviates .*Routes/);
  const areaRows = overviewRows(overview, 'Areas');
  assert.ok(areaRows.length > 11, 'keeps more than the minimum 10 direct area links when space allows');
  assert.match(areaRows.at(-1), /^- \[\d+ more areas\]\(<neorion\/graph\/\+areas\.md>\)$/);
  assert.match(overview, /\d+ more, use `api_consumers` with the action name\./);
  assert.ok(count(overview) <= 1500);
  assertOverviewLinks(project, overview);
});

test('preserves the HEAD index overview byte for byte and lists every area across its pages', async t => {
  const project = reviewFixture(t);
  for (let i = 0; i < 180; i++) {
    addOverviewSource(project, `app/(long-generated-area-name-${i})/card.tsx`, 'export function Card() { return <div />; }');
  }
  const overview = await generate(project);
  assert.equal(overview, fs.readFileSync(path.join(__dirname, 'goldens/overview-index.md'), 'utf8'));
  assert.deepEqual(overviewRows(overview, 'Areas'), ['- [Area index](<neorion/graph/+areas.md>)']);
  assert.ok(count(overview) <= 1500);
  assertOverviewLinks(project, overview);
  const dir = cachePath(project, 'neorion/graph');
  const files = fs.readdirSync(dir);
  const indexes = files.filter(file => file.startsWith('+areas'));
  assert.ok(indexes.length > 1);
  const pages = indexes.map(index => fs.readFileSync(path.join(dir, index), 'utf8'));
  for (const page of pages) assert.ok(count(page) <= 3000);
  const listedAreas = pages.flatMap(page => [...page.matchAll(/^- .*\]\(<([^>]+)>\)$/gm)].map(match => match[1]));
  const areaFiles = files.filter(file => (!file.startsWith('+') || file === '+dependencies.md') && !/\+\d+\.md$/.test(file));
  assert.equal(areaFiles.length, 188);
  assert.deepEqual(listedAreas.sort(), areaFiles.sort());
});

test('retains the HEAD area index and route rows when long area links exceed the budget', async t => {
  const project = reviewFixture(t);
  for (let i = 0; i < 11; i++) {
    const hex = createHash('sha512').update(String(i)).digest('hex').repeat(2).slice(0, 250);
    addOverviewSource(project, `app/(${hex}-${i})/page.tsx`);
  }
  for (let i = 0; i < 50; i++) addOverviewSource(project, `app/r/seg-${i}/deep/page.tsx`, 'export default function P(){return null}');

  const overview = await generate(project);
  assert.ok(overviewRows(overview, 'Routes').length >= 9, 'HEAD retained 9 route rows');
  assert.deepEqual(overviewRows(overview, 'Areas'), ['- [Area index](<neorion/graph/+areas.md>)']);
  assert.ok(count(overview) <= 1500);
  assertOverviewLinks(project, overview);
});

test('keeps the HEAD route rows when the action note costs space and all area links fit', async t => {
  const project = reviewFixture(t);
  for (let i = 0; i < 100; i++) addOverviewSource(project, `app/r/customer-record-${i}/deep/page.tsx`);
  const actions = Array.from({ length: 40 }, (_, i) => `export async function updateRecord${i}() {}`);
  addOverviewSource(project, 'lib/generated-actions.ts', ['"use server";', ...actions].join('\n'));

  const overview = await generate(project);
  assert.equal(overviewRows(overview, 'Areas').length, 9);
  assert.equal(overviewRows(overview, 'Routes').length, 78);
  assert.match(overview, /^Overview abbreviates Routes, Server actions\./);
  assert.ok(!fs.readdirSync(cachePath(project, 'neorion/graph')).some(file => file.startsWith('+areas')));
});

test('keeps the most used hook when the overview truncates hook definitions', async t => {
  const project = reviewFixture(t);
  const hooks = path.join(project, 'src/lib');
  for (let i = 0; i < 200; i++) {
    fs.writeFileSync(path.join(hooks, `a-low-${i}.ts`), `export function useLow${i}() { return 0; }`);
  }
  fs.writeFileSync(path.join(hooks, 'z-team.ts'), 'export function useTeam() { return 0; }');
  for (const name of ['first', 'second']) {
    fs.writeFileSync(path.join(hooks, name + '.ts'), "import { useTeam } from './z-team'; useTeam()");
  }
  const overview = await generate(project);
  assert.match(overview, /^Overview abbreviates Project hooks/);
  assert.match(overview, /src\/lib\/z-team.ts: useTeam/);
  assert.match(readMap(project, overview, 'review-fixture')['+reverse-hooks.md'],
    /useTeam \(2\)\n  src\/lib\/: first.ts second.ts/);
});

test('publishes distinct literal paths for percent, route-group and tilde names', async t => {
  const project = reviewFixture(t);
  for (const area of ['(report%2F)', '(report~)', '(report)']) {
    const directory = path.join(project, 'src/app', area);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'page.tsx'), 'export default function Report() { return null; }');
  }
  const overview = await generate(project);
  assertOverviewLinks(project, overview);
  assert.doesNotMatch(overview, /<[^>]*%[^>]*>/);
  assert.match(overview, /<neorion\/graph\/src~app~\(report\)\.md>/);
});

const benchRepos = process.env.NEORION_BENCH_REPOS;
for (const name of ['ai-chatbot', 'papermark']) {
  test(`${name} overview links open literally and remain within independent token budgets`, { skip: !benchRepos }, async t => {
    const { execFileSync } = require('node:child_process');
    const source = path.resolve(benchRepos, name);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neorion-bench-test-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const project = path.join(tmp, name);
    execFileSync('git', ['clone', '--quiet', '--shared', source, project]);
    const listing = execFileSync('git', ['-C', project, 'ls-files', '-z'], { encoding: 'utf8' })
      .split('\0').filter(Boolean).join('\n') + '\n';
    const overview = await generate(project);
    assertOverviewLinks(project, overview);
    assert.ok(count(overview) <= overviewBudget(listing));
    const directory = cachePath(project, 'neorion/graph');
    let detailTotal = 0;
    for (const file of fs.readdirSync(directory)) {
      const tokens = count(fs.readFileSync(path.join(directory, file), 'utf8'));
      assert.ok(tokens <= 3000, file);
      detailTotal += tokens;
    }
    const lines = fs.readdirSync(directory).flatMap(file => fs.readFileSync(path.join(directory, file), 'utf8').split('\n'));
    if (name === 'ai-chatbot') {
      assert.doesNotMatch(lines.join('\n'), /^rendered app\/\(auth\)\/layout\.tsx#AuthLayout <-/m);
      for (const fact of [
        'rendered components/ai-elements/shimmer.tsx#Shimmer <- app/(chat)/page.tsx / (via layout)',
        'rendered components/chat/artifact-close-button.tsx#ArtifactCloseButton <- app/(chat)/page.tsx / (via layout)',
        'rename app/(chat)/actions.ts#deleteTrailingMessages <- components/chat/message-editor.tsx',
        'rename components/chat/data-stream-provider.tsx#DataStreamProvider <- app/(chat)/layout.tsx'
      ]) assert.ok(lines.includes(fact), `Missing ${fact}`);
    }
    if (name === 'papermark') {
      assert.ok(detailTotal <= 90_000, `Papermark detail tokens: ${detailTotal}`);
      const chains = [...lines.join('\n').matchAll(/^wrap (@[a-f0-9]+) \(80 pages\) <- pages\/_app\.tsx .* \(conditional\)$/gm)];
      assert.equal(chains.length, 2);
      for (const [, id] of chains) {
        assert.equal(lines.filter(line => line.startsWith('wrap pages/') && line.endsWith(` <- ${id}`)).length, 80);
        assert.ok(lines.includes(`wrap pages/branding.tsx <- ${id}`));
      }
      const expectedSubjects = [
        ['rendered components/ai-elements/message.tsx#MessageResponse <- ', 6],
        ['rendered components/datarooms/actions/generate-index-button.tsx#GenerateIndexButton <- ', 2],
        ['fetch components/welcome/dataroom-ai-generate.tsx -> ', 2],
        ['fetch components/view/dataroom/viewer-download-progress-modal.tsx -> ', 2],
        ['rename ee/features/workflows/components/workflow-list.tsx#WorkflowList <- ', 2]
      ];
      for (const [prefix, expected] of expectedSubjects) {
        assert.equal(lines.filter(line => line.startsWith(prefix)).length, expected, prefix);
      }
      for (const fact of [
        'rendered components/ai-elements/message.tsx#MessageResponse <- pages/view/[linkId]/embed.tsx /view/[linkId]/embed',
        'rename context/team-context.tsx#useTeam <- 178 files (list omitted)',
        'fetch pages/account/general.tsx -> pages/api/account/index.ts /api/account',
        'fetch components/analytics/documents-table.tsx -> pages/api/analytics/index.ts /api/analytics (SWR key)',
        'fetch components/analytics/views-table.tsx -> pages/api/analytics/index.ts /api/analytics (SWR key)',
        'fetch components/datarooms/groups/group-card.tsx -> pages/api/teams/[teamId]/datarooms/[id]/groups/[groupId]/duplicate.ts /api/teams/[teamId]/datarooms/[id]/groups/[groupId]/duplicate',
        'rendered components/agreements/signing-template-authoring.tsx#SigningTemplateAuthoring <- 62 pages (list omitted)',
        'rendered components/analytics/analytics-card.tsx#AnalyticsCard <- pages/dashboard.tsx /dashboard'
      ]) assert.ok(lines.includes(fact), `Missing ${fact}`);
      assert.match(lines.join('\n'), /^fetch .* \(SWR key\)$/m);
      assert.match(overview, /context\/team-context.tsx: useTeam/);
      assert.match(overview, /\[\[\.\.\.file\]\].ts\[\*\]/);
      assert.match(overview, /members.ts\[GET DELETE\]/);
      const hooks = fs.readFileSync(path.join(directory, '+reverse-hooks.md'), 'utf8');
      assert.match(hooks, /^useTeam \(177\)$/m);
      const renders = fs.readFileSync(path.join(directory, '+reverse-renders.md'), 'utf8');
      assert.match(renders, /ProBannerSection \(5\)\n  components\/links\/link-sheet\/: link-options.tsx\n  components\/welcome\/containers\/: onboarding-dataroom-link-options.tsx onboarding-link-options.tsx\n  pages\/settings\/presets\/: \[id\].tsx new.tsx/);
    }
  });
}

test('connects only selected AI instructions after consent, once per project, and restores originals', async t => {
  const project = reviewFixture(t);
  const agentFile = path.join(project, 'AGENTS.md');
  const cursorRule = path.join(project, '.cursor/rules/neorion.mdc');
  const claudeFile = path.join(project, 'CLAUDE.md');
  const instructions = 'Existing instructions.\r\n';
  const cursor = '---\r\ndescription: Existing rule\r\nalwaysApply: false\r\n---\r\nExisting body.';
  fs.writeFileSync(agentFile, instructions);
  fs.mkdirSync(path.dirname(cursorRule), { recursive: true });
  fs.writeFileSync(cursorRule, cursor);
  let answer;
  let prompts = 0;
  let picks = 0;
  let selection = ['AGENTS.md', '.cursor/rules/neorion.mdc'];
  const state = new Map();
  const options = {
    workspaceState: { get: key => state.get(key), update: async (key, value) => state.set(key, value) },
    window: {
      async showInformationMessage(_message, ...choices) {
        if (choices.includes('Yes')) { prompts++; return answer; }
      },
      async showQuickPick(items) {
        picks++;
        assert.deepEqual(items.filter(item => item.picked).map(item => item.label),
          fs.existsSync(cursorRule) ? ['AGENTS.md', '.cursor/rules/neorion.mdc'] : ['AGENTS.md']);
        return items.filter(item => selection.includes(item.label));
      }
    }
  };
  const { commands } = register(project, undefined, [], options);
  await commands.get('neo.generateGraph')();
  await commands.get('neo.generateGraph')();
  assert.equal(prompts, 1);
  assert.equal(picks, 0);
  assert.equal(fs.readFileSync(agentFile, 'utf8'), instructions);
  assert.equal(fs.readFileSync(cursorRule, 'utf8'), cursor);

  state.clear();
  answer = 'Yes';
  await commands.get('neo.generateGraph')();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(prompts, 2);
  assert.equal(picks, 1);
  const connected = fs.readFileSync(agentFile, 'utf8');
  assert.match(connected, /<!-- neorion:start -->\r\n.*read the Neorion overview.*codebase_graph\.md/);
  assert.match(fs.readFileSync(cursorRule, 'utf8'), /^---\r\ndescription: Existing rule\r\nalwaysApply: true\r\n---/);
  assert.ok(count(connected.slice(0, connected.indexOf(instructions))) <= 150);
  assert.ok(!fs.existsSync(claudeFile));

  selection = [...selection, 'CLAUDE.md'];
  await commands.get('neo.connectAITools')();
  assert.equal(fs.readFileSync(agentFile, 'utf8'), connected);
  assert.ok(fs.existsSync(claudeFile));
  await commands.get('neo.disconnectAITools')();
  await commands.get('neo.disconnectAITools')();
  assert.equal(fs.readFileSync(agentFile, 'utf8'), instructions);
  assert.equal(fs.readFileSync(cursorRule, 'utf8'), cursor);
  assert.ok(!fs.existsSync(claudeFile));
  assert.ok(fs.existsSync(path.dirname(cursorRule)));

  fs.rmSync(path.dirname(cursorRule), { recursive: true });
  selection = ['.cursor/rules/neorion.mdc'];
  await commands.get('neo.connectAITools')();
  assert.match(fs.readFileSync(cursorRule, 'utf8'), /neorion:state \{.*"createdRulesDirectory":true/);
  await commands.get('neo.disconnectAITools')();
  assert.ok(!fs.existsSync(path.dirname(cursorRule)));

  await commands.get('neo.connectAITools')();
  const otherRule = path.join(path.dirname(cursorRule), 'other.mdc');
  fs.writeFileSync(otherRule, 'keep');
  await commands.get('neo.disconnectAITools')();
  assert.equal(fs.readFileSync(otherRule, 'utf8'), 'keep');
});

test('emits transitive render, App and Pages wrapping, rename and API facts with project paths', async t => {
  const project = reviewFixture(t);
  const write = (file, source) => {
    const target = path.join(project, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
  };
  write('src/components/architecture.tsx', `
    export function Leaf() { return <aside /> }
    export function Middle() { return <Leaf /> }
    export function InnerProvider({ children }) { return <Context.Provider>{children}</Context.Provider> }
    export function OuterProvider({ children: content }) { return <InnerProvider>{content}</InnerProvider> }
    export function useArchitecture() { return 1 }
  `);
  write('src/components/barrel.ts', `
    export { Leaf as Renamed, Middle, OuterProvider, useArchitecture } from './architecture';
    export { report as reportAlias } from '../app/report';
  `);
  write('src/components/index.ts', "export * from './barrel'");
  write('src/app/help/page.tsx', `
    import { Middle as Content, Renamed, useArchitecture as useLocal, reportAlias as submit } from '@/components';
    export default function Help() { return <Content /> }
  `);
  write('src/app/layout.tsx', `
    import { OuterProvider as Provider } from '@/components';
    export default function RootLayout({children}) { return <Provider>{children}</Provider> }
  `);
  write('src/app/(account)/template.tsx', 'export default function Template({children}) { return <main>{children}</main> }');
  write('src/pages/_app.tsx', `
    import { OuterProvider } from '@/components';
    export default function App({ Component: Screen }) {
      const getLayout = Screen.getLayout ?? (page => page);
      return Screen.skip ? getLayout(<Screen />) : (Screen.ready && <OuterProvider>{getLayout(<Screen />)}</OuterProvider>);
    }
  `);
  write('src/pages/index.tsx', `
    import * as components from '@/components';
    export default function Index() { return <components.Middle /> }
    Index.getLayout = page => <PageProvider>{page}</PageProvider>;
    Index.skip = process.env.SKIP_SHELL === '1';
    Index.ready = process.env.SHELL_READY === '1';
    function PageProvider({children}) { return <section>{children}</section> }
  `);
  write('src/app/api/report/[id]/route.ts', 'export function GET() {} export function POST() {}');
  write('src/app/api/report/latest/route.ts', 'export function GET() {}');
  write('src/pages/api/optional/[[...slug]].ts', 'export default function handler() {}');
  write('src/components/fetches.ts', `
    'use client';
    export const latest = () => fetch('/api/report/latest?format=json');
    export const optional = () => fetch('/api/optional');
    export const save = (id) => fetch(\`/api/report/\${id}\`, { method: 'POST' });
    export const missing = () => fetch('/api/unmapped');
  `);
  write('src/components/requests.ts', `
    import read from 'swr';
    import axios from 'axios';
    const key = ['/api/report/latest?format=json', 'json'] as const;
    export const useReport = (ready) => read(ready ? key : null);
    export const sendReport = () => axios.post('/api/report/123');
  `);
  write('src/components/ui/primitive.tsx', 'export function Primitive() { return null }');
  for (let i = 0; i < 9; i++) {
    write(`src/consumers/consumer-${i}.tsx`, `
      import { useArchitecture } from '@/components';
      import { Primitive } from '@/components/ui/primitive';
      export const Consumer = () => <Primitive value={useArchitecture()} />;
    `);
  }
  write('src/app/report.ts', `
    'use server';
    import { save } from '../components/fetches';
    export async function report(id) { return save(id) }
    export async function inline() { return fetch('/api/report/123') }
  `);
  const overview = await generate(project);
  const details = Object.values(readMap(project, overview, 'review-fixture')).join('\n');
  const actualFacts = details.split('\n').filter(line => /^(rendered|wrap|rename|fetch) /.test(line));
  for (const fact of [
    'rendered src/components/architecture.tsx#Leaf <- src/app/help/page.tsx /help',
    'rendered src/components/architecture.tsx#Leaf <- src/pages/index.tsx /',
    'rendered src/components/architecture.tsx#InnerProvider <- src/pages/index.tsx / (via layout)',
    'wrap src/app/help/page.tsx <- src/app/layout.tsx > src/components/architecture.tsx#OuterProvider > src/components/architecture.tsx#InnerProvider > src/components/architecture.tsx#Context.Provider',
    'wrap src/app/(account)/page.tsx <- src/app/layout.tsx > src/components/architecture.tsx#OuterProvider > src/components/architecture.tsx#InnerProvider > src/components/architecture.tsx#Context.Provider > src/app/(account)/layout.tsx > src/components/panel.tsx#Panel > src/components/ui/button.tsx#Button > src/app/(account)/template.tsx',
    'wrap src/pages/index.tsx <- src/pages/_app.tsx > src/components/architecture.tsx#OuterProvider > src/components/architecture.tsx#InnerProvider > src/components/architecture.tsx#Context.Provider > src/pages/index.tsx#PageProvider (conditional)',
    'wrap src/pages/index.tsx <- src/pages/_app.tsx > src/pages/index.tsx#PageProvider (conditional)',
    'rename src/components/architecture.tsx#Leaf <- src/components/barrel.ts',
    'rename src/components/architecture.tsx#Leaf <- src/app/help/page.tsx',
    'rename src/components/architecture.tsx#Middle <- src/pages/index.tsx',
    'rename src/components/architecture.tsx#useArchitecture <- 11 files (list omitted)',
    'rename src/app/report.ts#report <- src/app/help/page.tsx',
    'fetch src/components/fetches.ts -> src/app/api/report/latest/route.ts /api/report/latest',
    'fetch src/components/fetches.ts -> src/app/api/report/[id]/route.ts /api/report/[id]',
    'fetch src/components/fetches.ts -> src/pages/api/optional/[[...slug]].ts /api/optional/[[...slug]]',
    'fetch src/components/requests.ts -> src/app/api/report/latest/route.ts /api/report/latest (SWR key)',
    'fetch src/components/requests.ts -> src/app/api/report/[id]/route.ts /api/report/[id] (axios)',
    'fetch src/app/report.ts#report -> src/app/api/report/[id]/route.ts /api/report/[id]',
    'fetch src/app/report.ts#inline -> src/app/api/report/[id]/route.ts /api/report/[id]'
  ]) assert.ok(actualFacts.includes(fact), `Missing ${fact}\n${actualFacts.join('\n')}`);
  assert.doesNotMatch(details, /^rename .*#Primitive <-/m);
  assert.doesNotMatch(details, /^rename .*#useArchitecture <- src\//m);
  assert.doesNotMatch(details, /^rename .*#Leaf <- src\/components\/index\.ts$/m);
  assert.doesNotMatch(details, /^rendered src\/app\/help\/page\.tsx#Help <- src\/app\/help\/page\.tsx /m);
  assert.doesNotMatch(details, /\/api\/unmapped/);
  assert.doesNotMatch(details, /rendered src\/components\/architecture\.tsx#Leaf <- src\/app\/\(account\)\/page/);
});

test('marks early-return fallbacks and switch branches in wrapper chains', async t => {
  const project = reviewFixture(t);
  fs.writeFileSync(path.join(project, 'src/pages/index.tsx'), 'export default function Home() { return null }');
  fs.writeFileSync(path.join(project, 'src/pages/_app.tsx'), `
    export default function App({ Component, pageProps }) {
      switch (pageProps.team) {
        case true: return <Shell><TeamProvider><Component /></TeamProvider></Shell>;
        default: break;
      }
      if (pageProps.minimal) return <Shell><Component /></Shell>;
      return <Shell><FallbackProvider><Component /></FallbackProvider></Shell>;
    }
  `);
  const overview = await generate(project);
  const details = Object.values(readMap(project, overview, 'review-fixture')).join('\n');
  for (const chain of ['#Shell', '#Shell > src/pages/_app.tsx#TeamProvider',
    '#Shell > src/pages/_app.tsx#FallbackProvider']) {
    assert.ok(details.split('\n').some(line => line.startsWith('wrap ') &&
      line.endsWith(`src/pages/_app.tsx${chain} (conditional)`)), chain);
  }
  assert.doesNotMatch(details, /^wrap .* <- .*#FallbackProvider$/m);
});

test('moves generated details out of the source tree and preserves handwritten legacy files', async t => {
  const project = reviewFixture(t);
  const legacy = path.join(project, '.neorion/graph');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'generated.md'), '<!-- Generated by Neorion -->\nold');
  fs.writeFileSync(path.join(legacy, 'notes.md'), 'handwritten');
  const overview = await generate(project);
  assert.match(overview, /neorion\/graph\//);
  assert.doesNotMatch(overview, /\.neorion\/graph\//);
  assert.ok(fs.existsSync(cachePath(project, 'neorion/graph/src~components.md')));
  assert.ok(!fs.existsSync(path.join(legacy, 'generated.md')));
  assert.equal(fs.readFileSync(path.join(legacy, 'notes.md'), 'utf8'), 'handwritten');
});
