'use strict';
// Builds ../tasks.jsonl (v7, rallly apps/web) from ../review/selection.json and out/rallly.handwritten.json.
// T1 and T3 wording is the v6 wording with the app scope changed. T2 adds one sentence on workspace packages.
// T4 counts URL strings in links and absoluteUrl() calls because rallly's UI reaches its REST routes that way.
// T7 (two concept tasks), T6 and T8 (controls) are new in v7.
const L = require('./lib.cjs');
const { fs, path } = L;
const ROOT = path.join(__dirname, '..');
const sel = JSON.parse(fs.readFileSync(path.join(ROOT, 'review', 'selection.json'), 'utf8')).filter((s) => !s.skipped);
const hw = JSON.parse(fs.readFileSync(path.join(__dirname, 'out', 'rallly.handwritten.json'), 'utf8'));
const repo = 'rallly';
const SCOPE = 'the Rallly web app (the Next.js app at apps/web of the rallly monorepo; your working directory is that folder and all paths are relative to it)';
const TEST_DEF = 'Test files are files named *.test.* or *.spec.*, files under __tests__ or __mocks__, and everything under tests/ or src/test/.';
const FORMAT = 'Reply with a JSON object {"answer": [...]} and nothing else. Use repository-relative paths with forward slashes.';
const ROUTE_FORMAT = 'Reply with a JSON object {"answer": [...]} and nothing else. Write routes as file-system patterns: leading slash, route groups such as (chat) removed, index dropped, dynamic segments kept as written, for example /documents/[id]. Keep every other segment as written, including the leading [locale] segment.';

function t1(d) {
  return {
    question: `In ${SCOPE}, which route URLs can end up rendering the component \`${d.name}\` declared in \`${d.file}\`, directly or through intermediate components? A route counts if its page file, or a layout (App Router) or pages/_app.tsx (Pages Router) wrapping it, renders \`${d.name}\` through any chain of JSX elements in any conditional branch. Only real Next.js routes count (page files under pages/ or app/**/page.tsx, with or without a src/ prefix); API routes do not. ${ROUTE_FORMAT}`,
    answer: d.routes, answer_kind: 'route_set', evidence: d.evidence,
  };
}
function t2(d) {
  return {
    question: `In ${SCOPE}, when the route \`${d.route}\` (page file \`${d.pageFile}\`) is rendered, which project files declare the framework wrappers and wrapper components that enclose the page content, from outermost to innermost? Include pages/_app.tsx or every layout file on the route's path. Then include the file declaring each project-local component that is a JSX ancestor of the page content, following recursively into project components that wrap their children. For a Pages Router page, also include the page component's outermost returned JSX element if it is a project component. Evaluate route-dependent conditions for this route. Exclude third-party components, components declared outside this app folder (for example in @rallly/ui or other workspace packages, even when a project file re-exports them), and anything rendered beside the content rather than around it. Treat member elements such as <SomeContext.Provider> or <trpc.Provider> as third-party, even when SomeContext or trpc is declared in a project file. List each file once, at its outermost position. ${FORMAT}`,
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
    question: `In ${SCOPE}, which non-test files are API consumers of the route \`${d.url}\` (handler \`${d.routeFile}\`)? A file counts if (a) its code contains a URL string for this route (a string or template literal passed to fetch, used as a link href or image source, passed to absoluteUrl(), or placed in a request or configuration object, including query-string variants and any sub-path the route handles), or (b) it references, by import or call, an exported project function from a file in (a) that builds such a URL. Follow (b) one level only. Do not count other routes whose paths merely share a prefix, comments, other symbols that only share a name with such a function, the handler file, or test files. ${TEST_DEF} ${FORMAT}`,
    answer: d.v4.files, answer_kind: 'file_set',
    evidence: {
      request_sites: d.occurrences.filter((o) => !/\.(test|spec)\./.test(o.file)).map((o) => `${o.file}:${o.line} ${o.literal} [${o.context}] in ${o.topDecl}`),
      request_functions: d.v4.requestFunctions, callers: d.v4.callerEvidence, excluded_test_mentions: d.testFiles,
    },
  };
}
function t7a(d) {
  return {
    question: `In ${SCOPE}, Rallly's public REST API authenticates callers with API keys: it stores only a hash of each key and checks the key presented with a request against that hash. Which non-test files make up this API key path? Include (1) the file that declares the functions that hash a new key and verify a presented key, (2) every file that references, by import or call, an exported function of the file in (1), and (3) every file that references, by import or call, an exported value of a file in (2) that verifies presented keys. Follow (3) one level only. Do not count other token or secret generation code (OAuth state, upload tokens, session tokens), type-only references, or test files. ${TEST_DEF} ${FORMAT}`,
    answer: d.files, answer_kind: 'file_set',
    evidence: { key_file: d.keyFile, key_exports: d.keyExports, key_refs: d.keyRefs, verifier_file: d.verifierFile, verifier_export_refs: d.verifierExportRefs, excluded_test_files: d.testFilesExcluded },
  };
}
function t7b(d) {
  return {
    question: `In ${SCOPE}, notification emails carry a signed one-click unsubscribe token, and Rallly checks that token when the recipient follows the link or the mail client posts to it. Which non-test files make up this token path? Include (1) the file that declares the low-level sign and verify helpers the token code calls, (2) the file that declares the functions that create and parse the token, (3) every file that calls the create or parse function, and (4) every file that references, by import or call, an exported function from a file in (3) that itself calls the parse function. Follow (4) one level only. Do not count other code that uses the same signing helpers for a different purpose, type-only references, or test files. ${TEST_DEF} ${FORMAT}`,
    answer: d.files, answer_kind: 'file_set',
    evidence: { signature_file: d.sigFile, token_file: d.tokenFile, create_refs: d.createRefs, parse_refs: d.parseRefs, parse_wrappers: d.parseWrappers, wrapper_refs: d.wrapperRefs, other_signature_users_excluded: d.otherSignatureUsers },
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
    question: `In ${SCOPE}, which code files read the environment variable \`${d.env}\`, either directly (process.env.${d.env}) or through the validated \`env\` object exported by src/env.ts (env.${d.env})? Count .ts, .tsx, .js, .jsx, .mjs and .cjs files only; do not count .env files or documentation. ${FORMAT}`,
    answer: d.files, answer_kind: 'file_set',
    evidence: { reads: d.reads, note: 'control task: environment variable reads are not code-graph edges; a single text search for the name gives the answer' },
  };
}
function t8(d) {
  return {
    question: `In ${SCOPE}, which code files use the translation key \`${d.key}\` (for example t("${d.key}") or i18nKey="${d.key}")? Count .ts, .tsx, .js, .jsx, .mjs and .cjs files only; do not count locale JSON files. ${FORMAT}`,
    answer: d.files, answer_kind: 'file_set',
    evidence: { uses: d.uses, note: 'control task: translation keys are string literals, not code-graph edges; a single text search for the key gives the answer' },
  };
}
const SUBJECT = { T1: (d) => d.key, T2: (d) => d.route, T3: (d) => d.key, T4: (d) => d.url };
const BUILD = { T1: t1, T2: t2, T3: t3, T4: t4 };
const rows = [];
for (const type of ['T1', 'T2', 'T3', 'T4']) {
  for (const s of sel.filter((x) => x.type === type)) rows.push({ type, difficulty: s.band, subject: SUBJECT[type](s.data), ...BUILD[type](s.data) });
}
rows.push({ type: 'T7', difficulty: 'medium', subject: 'concept: API key hashing and verification', ...t7a(hw.t7a) });
rows.push({ type: 'T7', difficulty: 'hard', subject: 'concept: one-click unsubscribe token', ...t7b(hw.t7b) });
rows.push({ type: 'T6', difficulty: 'control', subject: `env: ${hw.t6.env}`, ...t6(hw.t6) });
rows.push({ type: 'T8', difficulty: 'control', subject: `i18n key: ${hw.t8.key}`, ...t8(hw.t8) });
const tasks = rows.map((r, i) => ({ id: `v7-rallly-${String(i + 1).padStart(2, '0')}`, repo, app_subdir: L.APP_SUBDIR[repo], commit: L.PINNED[repo], ...r }));
for (const t of tasks) {
  if (t.answer_kind !== 'ordered_file_list') t.answer = [...t.answer].sort();
  if (t.answer.length < 1) throw new Error(`${t.id} empty answer`);
}
fs.writeFileSync(path.join(ROOT, 'tasks.jsonl'), tasks.map((t) => JSON.stringify(t)).join('\n') + '\n');
console.log(tasks.map((t) => `${t.id} ${t.type} ${t.difficulty} ${t.subject} (${t.answer.length})`).join('\n'));
