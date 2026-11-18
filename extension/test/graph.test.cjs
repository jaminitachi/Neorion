const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { count, assertOverviewLinks, overviewBudget } = require('./graph-output.cjs');
const { generate, visualize } = require('./run.cjs');
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
    filter: file => !['.git', 'node_modules', '.next', '.neorion', 'codebase_graph.md'].includes(path.basename(file))
  });
  return { tmp, project };
}

function readMap(project, overview, name) {
  assert.ok(overview.startsWith('# ' + name + ' architecture') ||
    overview.split('\n').includes('# ' + name + ' architecture (mixed router)'));
  const root = path.join(project, '.neorion/graph');
  const details = fs.readdirSync(root).filter(file => file.endsWith('.md'));
  assertOverviewLinks(project, overview);
  const files = Object.fromEntries(details.map(file => [file, fs.readFileSync(path.join(root, file), 'utf8')]));
  for (const [file, detail] of Object.entries(files)) {
    assert.ok(count(detail) <= 3000, file);
    assert.ok(!detail.includes(project));
    assert.doesNotMatch(detail, /:\s+(?:GET|HEAD|POST|PUT|DELETE|PATCH|OPTIONS)\(/);
    if (file === '+dependencies.md' || file.startsWith('+reverse-')) continue;
    let directory;
    for (const line of detail.split('\n')) {
      if (line.endsWith('/') && !line.startsWith(' ')) directory = line;
      if (line.startsWith('  ') && line.includes(': ')) {
        const basename = line.trim().split(': ')[0].replace(/ \(c\)$/, '');
        assert.ok(fs.existsSync(path.join(project, directory, basename)), `${directory}${basename}`);
      }
    }
  }
  return files;
}

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
    function wrap(handler) {
      return async (req, res) => {
        await handler({ ...await authenticate(req), req, res });
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
  const directory = path.join(project, '.neorion/graph');
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
  assert.match(overview, /<\.neorion\/graph\/src~app~\(report\)\.md>/);
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
    const directory = path.join(project, '.neorion/graph');
    for (const file of fs.readdirSync(directory)) {
      assert.ok(count(fs.readFileSync(path.join(directory, file), 'utf8')) <= 3000, file);
    }
    if (name === 'papermark') {
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
