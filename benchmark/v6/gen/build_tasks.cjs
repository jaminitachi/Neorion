'use strict';
// Builds ../tasks.jsonl (v6, dub apps/web) from ../review/selection.json and out/dub.handwritten.json.
// Question wording for T1 to T4 is the v4 wording with the app scope changed. T7 and T6 are new in v6.
const L = require('./lib.cjs');
const { fs, path } = L;
const ROOT = path.join(__dirname, '..');
const sel = JSON.parse(fs.readFileSync(path.join(ROOT, 'review', 'selection.json'), 'utf8')).filter((s) => !s.skipped);
const hw = JSON.parse(fs.readFileSync(path.join(__dirname, 'out', 'dub.handwritten.json'), 'utf8'));
const repo = 'dub';
const SCOPE = `the ${repo} web app (the Next.js app at apps/web of the ${repo} monorepo; your working directory is that folder and all paths are relative to it)`;
const TEST_DEF = 'Test files are files named *.test.* or *.spec.*, files under __tests__ or __mocks__, and everything under playwright/ or integration/.';
const FORMAT = 'Reply with a JSON object {"answer": [...]} and nothing else. Use repository-relative paths with forward slashes.';
const ROUTE_FORMAT = 'Reply with a JSON object {"answer": [...]} and nothing else. Write routes as file-system patterns: leading slash, route groups such as (chat) removed, index dropped, dynamic segments kept as written, for example /documents/[id]. Keep every other folder name as written, including host-named folders such as app.dub.co.';

function t1(d) {
  return {
    question: `In ${SCOPE}, which route URLs can end up rendering the component \`${d.name}\` declared in \`${d.file}\`, directly or through intermediate components? A route counts if its page file, or a layout (App Router) or pages/_app.tsx (Pages Router) wrapping it, renders \`${d.name}\` through any chain of JSX elements in any conditional branch. Only real Next.js routes count (files under pages/ or app/**/page.tsx); API routes do not. ${ROUTE_FORMAT}`,
    answer: d.routes, answer_kind: 'route_set', evidence: d.evidence,
  };
}
function t2(d) {
  return {
    question: `In ${SCOPE}, when the route \`${d.route}\` (page file \`${d.pageFile}\`) is rendered, which project files declare the framework wrappers and wrapper components that enclose the page content, from outermost to innermost? Include pages/_app.tsx or every layout file on the route's path. Then include the file declaring each project-local component that is a JSX ancestor of the page content, following recursively into project components that wrap their children. For a Pages Router page, also include the page component's outermost returned JSX element if it is a project component. Evaluate route-dependent conditions for this route. Exclude third-party components and anything rendered beside the content rather than around it. List each file once, at its outermost position. ${FORMAT}`,
    answer: d.files, answer_kind: 'ordered_file_list',
    evidence: { steps: d.steps.map((x) => `${x.file} (${x.component}) via ${x.via}`), notes: d.notes },
  };
}
function t3(d) {
  return {
    question: `In ${SCOPE}, suppose you rename the exported symbol \`${d.name}\` declared in \`${d.file}\` with a TypeScript-aware Rename Symbol (as an IDE does, without editing strings or comments). Which files receive edits? Include the declaring file. Other symbols that only share the name are not affected. ${FORMAT}`,
    answer: d.files, answer_kind: 'file_set',
    evidence: { rename_locations: d.lines, barrel_files: d.barrelFiles, via_barrel_importers: d.viaBarrelImporters, alias_files: d.aliasFiles, grep_false_positives: d.grepOnly },
  };
}
function t4(d) {
  return {
    question: `In ${SCOPE}, which non-test files are API consumers of the route \`${d.url}\` (handler \`${d.routeFile}\`)? A file counts if (a) its code sends HTTP requests to this exact route (URLs passed to fetch, SWR keys and mutate calls, axios, or request configuration objects, including query-string variants), or (b) it references, by import or call, an exported project function from a file in (a) that sends such a request. Follow (b) one level only. Do not count other routes whose paths merely share a prefix, other symbols that only share a name with such a function, the handler file, or test files. ${TEST_DEF} ${FORMAT}`,
    answer: d.v4.files, answer_kind: 'file_set',
    evidence: {
      request_sites: d.occurrences.filter((o) => !/\.(test|spec)\./.test(o.file)).map((o) => `${o.file}:${o.line} ${o.literal} [${o.context}] in ${o.topDecl}`),
      request_functions: d.v4.requestFunctions, callers: d.v4.callerEvidence, excluded_test_mentions: d.testFiles,
    },
  };
}
function t7(d) {
  return {
    question: `In ${SCOPE}, Dub signs every webhook delivery it sends to a user-configured webhook endpoint: it computes an HMAC over the JSON payload and sends it in a request header. Which non-test files make up this signing path? Include (1) the file that declares the function computing the signature, (2) the file that puts that signature into the outgoing request headers, and (3) every file that references, by import or call, an exported function of the file in (2). Follow (3) one level only. Do not count code that creates or verifies signatures for other purposes (incoming webhooks from Stripe, Shopify, Slack or similar, email unsubscribe tokens), type-only references, or test files. ${TEST_DEF} ${FORMAT}`,
    answer: d.files, answer_kind: 'file_set',
    evidence: { sign_function: `${d.signFile}#${d.signFn}`, sign_refs: d.signRefs, attach_file: d.attachFile, attach_exports: d.attachExports, caller_refs: d.callerRefs, excluded_test_callers: d.testCallersExcluded },
  };
}
function t6(d) {
  return {
    question: `In ${SCOPE}, which code files read the environment variable \`${d.env}\` (for example process.env.${d.env})? Count .ts, .tsx, .js, .jsx, .mjs and .cjs files only; do not count .env files or documentation. ${FORMAT}`,
    answer: d.files, answer_kind: 'file_set',
    evidence: { reads: d.reads, note: 'control task: environment variable reads are not code-graph edges; a single text search for the name gives the answer' },
  };
}
const SUBJECT = { T1: (d) => d.key, T2: (d) => d.route, T3: (d) => d.key, T4: (d) => d.url };
const BUILD = { T1: t1, T2: t2, T3: t3, T4: t4 };
const rows = [];
for (const type of ['T1', 'T2', 'T3', 'T4']) {
  for (const s of sel.filter((x) => x.type === type)) rows.push({ type, difficulty: s.band, subject: SUBJECT[type](s.data), ...BUILD[type](s.data) });
}
rows.push({ type: 'T7', difficulty: 'medium', subject: 'concept: outgoing webhook signature', ...t7(hw.t7) });
rows.push({ type: 'T6', difficulty: 'control', subject: `env: ${hw.t6.env}`, ...t6(hw.t6) });
const tasks = rows.map((r, i) => ({ id: `v6-dub-${String(i + 1).padStart(2, '0')}`, repo, app_subdir: L.APP_SUBDIR[repo], commit: L.PINNED[repo], ...r }));
for (const t of tasks) {
  if (t.answer_kind !== 'ordered_file_list') t.answer = [...t.answer].sort();
  if (t.answer.length < 1) throw new Error(`${t.id} empty answer`);
}
fs.writeFileSync(path.join(ROOT, 'tasks.jsonl'), tasks.map((t) => JSON.stringify(t)).join('\n') + '\n');
console.log(tasks.map((t) => `${t.id} ${t.type} ${t.difficulty} ${t.subject} (${t.answer.length})`).join('\n'));
