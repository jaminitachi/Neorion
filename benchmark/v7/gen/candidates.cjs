'use strict';
// Builds candidate pools with ground-truth answers for every task type.
// Usage: node candidates.cjs <repo>   -> gen/out/<repo>.candidates.json
const L = require('./lib.cjs');
const { ts, fs, path } = L;

const repoName = process.argv[2];
if (!L.PINNED[repoName]) throw new Error('unknown repo');
const repo = new L.Repo(repoName);
const g = L.buildGraph(repo);
const revRender = L.reverse(g.render);
const merged = new Map();
for (const m of [g.render, g.refs]) for (const [a, tos] of m) {
  if (!merged.has(a)) merged.set(a, new Map());
  for (const [b, ev] of tos) merged.get(a).set(b, ev);
}
const revMerged = L.reverse(merged);

const pageFiles = repo.codeFiles.filter((f) => L.pageRoute(f) !== null);
const fileOf = (k) => k.split('#')[0];
const nameOf = (k) => k.split('#')[1];
// v4: test and end-to-end files (excluded from T4 answers, and flagged in T3 grep false positives)
const isTestFile = (f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f) || /(^|\/)(__tests__|__mocks__)\//.test(f) || /^(playwright|integration|tests)\//.test(f) || /^src\/test\//.test(f) || /^vitestSetup/.test(f); // v7: rallly keeps e2e tests in tests/ and helpers in src/test/
const isFrameworkFile = (f) => L.pageRoute(f) !== null || /(^|\/)(layout|template|loading|error|not-found|route)\.(t|j)sx?$/.test(f) || /^pages\/_/.test(f) || /^pages\/api\//.test(f);

// == T1: transitive render ==
function reverseBfs(rev, start) {
  const dist = new Map([[start, 0]]);
  const parent = new Map();
  const q = [start];
  while (q.length) {
    const x = q.shift();
    const preds = rev.get(x);
    if (!preds) continue;
    for (const [p, ev] of preds) {
      if (dist.has(p)) continue;
      dist.set(p, dist.get(x) + 1);
      parent.set(p, [x, ev]);
      q.push(p);
    }
  }
  return { dist, parent };
}
// Render roots of a route: its page file plus every wrapping layout (App Router) or pages/_app (Pages Router).
function routeRoots(pageFile) {
  const roots = [pageFile];
  if (/^(src\/)?app\//.test(pageFile)) {
    const parts = pageFile.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      for (const base of ['layout', 'template']) for (const ext of ['tsx', 'ts', 'jsx', 'js']) {
        if (repo.trackedSet.has(`${dir}/${base}.${ext}`)) roots.push(`${dir}/${base}.${ext}`);
      }
    }
  } else if (repo.trackedSet.has('pages/_app.tsx')) roots.push('pages/_app.tsx');
  return roots;
}
const ROUTE_ROOTS = new Map(pageFiles.map((f) => [L.pageRoute(f), { pageFile: f, roots: routeRoots(f) }]));
function pagesReached(bfs) {
  const best = new Map(); // file -> {d,node}
  for (const [k, d] of bfs.dist) {
    if (d === 0) continue;
    const f = fileOf(k);
    if (!best.has(f) || best.get(f).d > d) best.set(f, { d, node: k });
  }
  const out = new Map();
  for (const [route, { pageFile, roots }] of ROUTE_ROOTS) {
    let hit = null;
    for (const r of roots) {
      const b = best.get(r);
      if (b && (!hit || b.d < hit.d)) hit = { ...b, file: r };
    }
    if (hit) out.set(route, { ...hit, pageFile, viaWrapper: hit.file !== pageFile });
  }
  return out;
}
function chain(bfs, node) {
  const steps = [];
  let n = node;
  while (bfs.parent.has(n)) {
    const [next, ev] = bfs.parent.get(n);
    steps.push(ev);
    n = next;
  }
  return steps;
}
const t1 = [];
for (const [target, preds] of revRender) {
  const f = fileOf(target);
  const nm = nameOf(target);
  if (!/^[A-Z]/.test(nm) || isFrameworkFile(f)) continue;
  const bJsx = reverseBfs(revRender, target);
  const bRef = reverseBfs(revMerged, target);
  const pj = pagesReached(bJsx);
  const pr = pagesReached(bRef);
  const routes = [...pj.keys()].sort();
  const refRoutes = [...pr.keys()].sort();
  const depths = [...pj.values()].map((v) => v.d);
  // duplicates: another declaration with the same name elsewhere
  t1.push({
    key: target,
    name: nm,
    file: f,
    directRenderers: preds.size,
    routes,
    pageFiles: routes.map((r) => pj.get(r).pageFile),
    viaWrapper: routes.filter((r) => pj.get(r).viaWrapper),
    roots: Object.fromEntries(routes.map((r) => [r, pj.get(r).file])),
    refOnlyRoutes: refRoutes.filter((r) => !pj.has(r)),
    minDepth: depths.length ? Math.min(...depths) : 0,
    maxDepth: depths.length ? Math.max(...depths) : 0,
    evidence: Object.fromEntries(routes.map((r) => [r, chain(bJsx, pj.get(r).node)])),
  });
}

// == T2: wrapping chain ==
function findDefaultExportFn(sf) {
  const checker = repo.checker;
  const modSym = checker.getSymbolAtLocation(sf);
  if (!modSym) return null;
  const def = checker.getExportsOfModule(modSym).find((e) => e.escapedName === 'default');
  if (!def) return null;
  return fnFromSymbol(def);
}
function fnFromSymbol(sym) {
  const s = L.resolveSymbol(repo.checker, sym);
  if (!s || !s.declarations) return null;
  for (const d of s.declarations) {
    if (!repo.isLocal(d.getSourceFile())) continue;
    let n = d;
    if (ts.isExportAssignment(n)) {
      if (ts.isIdentifier(n.expression)) return fnFromSymbol(repo.checker.getSymbolAtLocation(n.expression));
      n = n.expression;
    }
    if (ts.isVariableDeclaration(n)) n = n.initializer;
    while (n && ts.isCallExpression(n) && n.arguments.length) n = n.arguments[0]; // forwardRef(...), memo(...)
    if (n && (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n))) return n;
  }
  return null;
}
function lastReturnJsx(fn) {
  if (!fn || !fn.body) return null;
  if (!ts.isBlock(fn.body)) return fn.body;
  const rets = fn.body.statements.filter(ts.isReturnStatement);
  const r = rets[rets.length - 1];
  return r ? r.expression : null;
}
function unparen(e) {
  while (e && ts.isParenthesizedExpression(e)) e = e.expression;
  return e;
}
// Evaluate `X.includes(router.pathname)` for a given pathname when X is a const array of strings.
function evalCondition(cond, pathname) {
  cond = unparen(cond);
  if (ts.isCallExpression(cond) && ts.isPropertyAccessExpression(cond.expression) && cond.expression.name.text === 'includes' && /pathname$/.test(cond.arguments[0]?.getText())) {
    const sym = L.resolveSymbol(repo.checker, repo.checker.getSymbolAtLocation(cond.expression.expression));
    const d = sym?.declarations?.[0];
    if (d && ts.isVariableDeclaration(d) && d.initializer && ts.isArrayLiteralExpression(d.initializer)) {
      const vals = d.initializer.elements.filter(ts.isStringLiteral).map((s) => s.text);
      return vals.includes(pathname);
    }
  }
  return undefined;
}
// JSX ancestors (outer to inner) of every slot in fn; slotTest(node) identifies the slot.
function slotAncestors(fn, slotTest, pathname, notes) {
  const chains = [];
  const walk = (node, stack) => {
    if (ts.isConditionalExpression(node)) {
      const v = evalCondition(node.condition, pathname);
      if (v !== undefined) {
        notes.push(`condition ${node.condition.getText()} = ${v} for ${pathname}`);
        walk(v ? node.whenTrue : node.whenFalse, stack);
        return;
      }
    }
    if (slotTest(node)) {
      chains.push(stack.slice());
      return;
    }
    if (ts.isJsxElement(node)) {
      const st = stack.concat([node.openingElement]);
      node.children.forEach((c) => walk(c, st));
      return;
    }
    if (ts.isFunctionLike(node) && node !== fn) return; // nested callbacks are not the render path
    ts.forEachChild(node, (c) => walk(c, stack));
  };
  const body = fn.body;
  if (body) walk(body, []);
  return chains;
}
const isChildrenSlot = (n) => ts.isJsxExpression(n) && n.expression && (/^(props\.)?children$/.test(n.expression.getText()));
function wrapperChain(fn, slotTest, pathname, depth, notes, out) {
  if (!fn || depth > 8) return;
  const chains = slotAncestors(fn, slotTest, pathname, notes);
  if (!chains.length) return;
  const sig = new Set(chains.map((c) => c.map((o) => o.tagName.getText()).join('>')));
  if (sig.size > 1) notes.push(`AMBIGUOUS: ${fn.getSourceFile().fileName.replace(repo.dir + '/', '')} has ${sig.size} different slot chains: ${[...sig].join(' | ')}`);
  for (const opening of chains[0]) {
    const tag = opening.tagName;
    if (/^[a-z]/.test(tag.getText())) continue;
    const sym = repo.checker.getSymbolAtLocation(ts.isPropertyAccessExpression(tag) ? tag.name : tag);
    const key = sym ? L.declKey(repo, sym) : null;
    if (!key) continue;
    out.push({ file: fileOf(key), component: nameOf(key), via: `${repo.rel(opening.getSourceFile().fileName)}:${opening.getSourceFile().getLineAndCharacterOfPosition(opening.getStart()).line + 1} <${tag.getText()}>` });
    wrapperChain(fnFromSymbol(sym), isChildrenSlot, pathname, depth + 1, notes, out);
  }
}
function t2For(pageFile) {
  const route = L.pageRoute(pageFile);
  const notes = [];
  const out = [];
  if (/^(src\/)?app\//.test(pageFile)) {
    const parts = pageFile.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      for (const ext of ['tsx', 'ts', 'jsx', 'js']) {
        const lf = `${dir}/layout.${ext}`;
        if (!repo.trackedSet.has(lf)) continue;
        out.push({ file: lf, component: 'default', via: 'App Router layout' });
        const sf = repo.program.getSourceFile(path.join(repo.dir, lf));
        wrapperChain(findDefaultExportFn(sf), isChildrenSlot, route, 1, notes, out);
      }
    }
  } else {
    const app = 'pages/_app.tsx';
    if (repo.trackedSet.has(app)) {
      out.push({ file: app, component: 'default', via: 'Pages Router _app' });
      const sf = repo.program.getSourceFile(path.join(repo.dir, app));
      const isComponentSlot = (n) => (ts.isJsxSelfClosingElement(n) || ts.isJsxElement(n)) && (ts.isJsxElement(n) ? n.openingElement : n).tagName.getText() === 'Component';
      wrapperChain(findDefaultExportFn(sf), isComponentSlot, route, 1, notes, out);
    }
    // the page's own root wrapper (for example an app layout shell)
    const sf = repo.program.getSourceFile(path.join(repo.dir, pageFile));
    const fn = findDefaultExportFn(sf);
    let root = unparen(lastReturnJsx(fn));
    if (root && ts.isJsxFragment(root)) notes.push('page root is a fragment');
    if (root && ts.isJsxElement(root)) {
      const tag = root.openingElement.tagName;
      if (!/^[a-z]/.test(tag.getText())) {
        const sym = repo.checker.getSymbolAtLocation(tag);
        const key = sym ? L.declKey(repo, sym) : null;
        if (key) {
          out.push({ file: fileOf(key), component: nameOf(key), via: `${pageFile} root <${tag.getText()}>` });
          wrapperChain(fnFromSymbol(sym), isChildrenSlot, route, 2, notes, out);
        }
      }
    }
  }
  const files = [];
  for (const o of out) if (!files.includes(o.file)) files.push(o.file);
  return { route, pageFile, files, steps: out, notes };
}
const t2 = pageFiles.map(t2For);

// == T4: API route consumers ==
const apiRoutes = repo.codeFiles.map((f) => ({ file: f, url: L.apiRoute(f) })).filter((r) => r.url);
function segKind(s) {
  if (/^\[\[\.\.\..+\]\]$/.test(s)) return 'optcatch';
  if (/^\[\.\.\..+\]$/.test(s)) return 'catch';
  if (/^\[.+\]$/.test(s)) return 'dyn';
  return 'static';
}
const PH = '\u0000';
function literalUrls(sf) {
  const found = [];
  const consumed = new Set();
  const flatten = (e, parts) => {
    e = unparen(e);
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      flatten(e.left, parts);
      flatten(e.right, parts);
    } else if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
      parts.push(e.text);
      consumed.add(e);
    } else if (ts.isTemplateExpression(e)) {
      parts.push(tmplText(e));
      consumed.add(e);
    } else parts.push(PH);
  };
  const tmplText = (e) => e.head.text + e.templateSpans.map((s) => PH + s.literal.text).join('');
  // v4: module specifiers (import/export from, import(), require(), vi.mock()/jest.mock() paths) are not URLs.
  const isModuleSpecifier = (n) => {
    const p = n.parent;
    if (!p) return false;
    if ((ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) && p.moduleSpecifier === n) return true;
    if (ts.isExternalModuleReference(p)) return true;
    if (ts.isLiteralTypeNode(p) && ts.isImportTypeNode(p.parent)) return true;
    if (ts.isCallExpression(p) && p.arguments[0] === n) {
      const callee = p.expression.kind === ts.SyntaxKind.ImportKeyword ? 'import' : p.expression.getText(sf);
      if (/^(import|require|(vi|jest)\.(mock|doMock|unmock|importActual|importMock|requireActual))$/.test(callee)) return true;
    }
    return false;
  };
  const visit = (n) => {
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && isModuleSpecifier(n)) return;
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken && !(ts.isBinaryExpression(n.parent) && n.parent.operatorToken.kind === ts.SyntaxKind.PlusToken)) {
      const parts = [];
      flatten(n, parts);
      const t = parts.join('');
      if (t.includes('/api')) found.push({ text: t, node: n });
    } else if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && !consumed.has(n)) {
      if (n.text.includes('/api')) found.push({ text: n.text, node: n });
    } else if (ts.isTemplateExpression(n) && !consumed.has(n)) {
      const t = tmplText(n);
      if (t.includes('/api')) found.push({ text: t, node: n });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}
function normalizeUrl(t) {
  const i = t.indexOf('/api/') >= 0 ? t.indexOf('/api/') : t.endsWith('/api') ? t.length - 4 : -1;
  if (i < 0) return null;
  let u = t.slice(i).split(/[?#]/)[0].replace(/\/+$/, '');
  return u.split('/').filter(Boolean).map((s) => (s === PH ? '*' : s.includes(PH) ? '~' : s));
}
// returns {route, ambiguous, reason} best match or null
function matchRoute(segs) {
  const ranked = [];
  for (const r of apiRoutes) {
    const rs = r.url.split('/').filter(Boolean);
    let ok = true;
    let amb = false;
    let score = [];
    let i = 0;
    for (; i < rs.length; i++) {
      const k = segKind(rs[i]);
      if (k === 'catch' || k === 'optcatch') {
        if (k === 'catch' && i >= segs.length) ok = false;
        score.push(1);
        i = rs.length;
        break;
      }
      if (i >= segs.length) { ok = false; break; }
      if (k === 'static') {
        if (segs[i] === rs[i]) score.push(3);
        else if (segs[i] === '*' || segs[i] === '~') { amb = true; score.push(0); }
        else { ok = false; break; }
      } else score.push(2);
    }
    const last = rs[rs.length - 1] || '';
    const hasCatch = /^\[\[?\.\.\./.test(last);
    if (ok && !hasCatch && segs.length !== rs.length) ok = false;
    if (ok) ranked.push({ route: r, amb, score });
  }
  if (!ranked.length) return null;
  ranked.sort((a, b) => {
    for (let i = 0; i < Math.max(a.score.length, b.score.length); i++) {
      const d = (b.score[i] || 0) - (a.score[i] || 0);
      if (d) return d;
    }
    return 0;
  });
  const best = ranked[0];
  const wildcardStaticHit = segs.includes('*') && ranked.length > 1;
  return { route: best.route, ambiguous: best.amb || segs.includes('~'), alternatives: wildcardStaticHit ? ranked.slice(1).map((x) => x.route.url) : [] };
}
const consumers = new Map(apiRoutes.map((r) => [r.url, []]));
const unmatched = [];
for (const sf of repo.sourceFiles()) {
  const file = repo.rel(sf.fileName);
  for (const { text, node } of literalUrls(sf)) {
    const segs = normalizeUrl(text);
    if (!segs || segs[0] !== 'api') continue;
    const m = matchRoute(segs);
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    let ctx = node.parent;
    while (ctx && (ts.isBinaryExpression(ctx) || ts.isParenthesizedExpression(ctx))) ctx = ctx.parent;
    const context = ctx ? ts.SyntaxKind[ctx.kind] + (ts.isCallExpression(ctx) || ts.isNewExpression(ctx) ? ':' + ctx.expression.getText(sf).slice(0, 40) : ts.isPropertyAssignment(ctx) ? ':' + ctx.name.getText(sf) : '') : '';
    const tl = L.topLevelOf(node);
    const topDecl = tl ? L.topLevelName(tl) : null;
    const topExported = !!tl && (tl.modifiers || []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword) && (ts.isFunctionDeclaration(tl) || (ts.isVariableStatement(tl) && tl.declarationList.declarations.length === 1 && !!tl.declarationList.declarations[0].initializer && (ts.isArrowFunction(tl.declarationList.declarations[0].initializer) || ts.isFunctionExpression(tl.declarationList.declarations[0].initializer))));
    const rec = { file, line, literal: text.replace(/\u0000/g, '${…}'), segs: segs.join('/'), context, topDecl, topExported };
    if (!m) { unmatched.push(rec); continue; }
    consumers.get(m.route.url).push({ ...rec, ambiguous: m.ambiguous, alternatives: m.alternatives });
  }
}
const t4 = apiRoutes.map((r) => {
  const c = consumers.get(r.url);
  const cNonTest = c.filter((x) => !isTestFile(x.file));
  const allFiles = [...new Set(c.map((x) => x.file))].filter((f) => f !== r.file).sort();
  // v4: the answer counts non-test source files only; test-only mentions are kept for the record
  const files = allFiles.filter((f) => !isTestFile(f));
  return { url: r.url, routeFile: r.file, files, testFiles: allFiles.filter(isTestFile), occurrences: c, anyAmbiguous: cNonTest.some((x) => x.ambiguous || x.alternatives.length), selfMentions: c.filter((x) => x.file === r.file).length };
});
// v4 T4 extension: request functions and their direct referencing files.
// A request site is a non-test occurrence inside an exported top-level function outside app/api and the
// route file. The answer is the set of non-test files with a request site plus every non-test file whose
// code references one of those exported functions (TypeScript symbol resolution, aliases and re-exports followed).
const revRefs = L.reverse(g.refs);
for (const c of t4) {
  const occ = c.occurrences.filter((o) => !isTestFile(o.file) && o.file !== c.routeFile);
  const reqFns = [...new Set(occ.filter((o) => o.topExported).map((o) => `${o.file}#${o.topDecl}`))];
  const nonFnSites = occ.filter((o) => !o.topExported || /^app\/api\//.test(o.file) || !/\.(ts|tsx)$/.test(o.file));
  const callers = new Map();
  for (const fn of reqFns) {
    for (const [from] of revRefs.get(fn) || []) {
      const f = fileOf(from);
      if (isTestFile(f)) continue;
      if (!callers.has(f)) callers.set(f, []);
      callers.get(f).push(`${from} -> ${fn}`);
    }
  }
  const reqFiles = [...new Set(occ.map((o) => o.file))];
  c.v4 = {
    requestFunctions: reqFns,
    nonFunctionSites: nonFnSites.map((o) => `${o.file}:${o.line} ${o.literal} [${o.context}]`),
    callerEvidence: Object.fromEntries([...callers].map(([f, ev]) => [f, ev])),
    files: [...new Set([...reqFiles, ...callers.keys()])].filter((f) => f !== c.routeFile).sort(),
  };
}

// literals with a wildcard in a position that could hit several routes, attributed per candidate route
const wildcardRisk = [];
for (const sf of repo.sourceFiles()) {
  const file = repo.rel(sf.fileName);
  if (isTestFile(file)) continue;
  for (const { text } of literalUrls(sf)) {
    const segs = normalizeUrl(text);
    if (!segs || segs[0] !== 'api') continue;
    if (!segs.some((s) => s === '*' || s === '~')) continue;
    for (const r of apiRoutes) {
      const rs = r.url.split('/').filter(Boolean);
      if (rs.length !== segs.length) continue;
      let hit = true, amb = false;
      for (let i = 0; i < rs.length; i++) {
        if (segKind(rs[i]) !== 'static') continue;
        if (segs[i] === rs[i]) continue;
        if (segs[i] === '*' || segs[i] === '~') { amb = true; continue; }
        hit = false; break;
      }
      if (hit && amb) wildcardRisk.push({ url: r.url, file, literal: text.replace(/\u0000/g, '${…}') });
    }
  }
}
for (const c of t4) c.wildcardRisk = wildcardRisk.filter((w) => w.url === c.url);

// == T3 / T6: rename impact ==
function exportedValueDecls() {
  const out = [];
  for (const sf of repo.sourceFiles()) {
    const file = repo.rel(sf.fileName);
    if (isFrameworkFile(file) || /\.d\.ts$/.test(file)) continue;
    for (const st of sf.statements) {
      const exp = (st.modifiers || []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      const dflt = (st.modifiers || []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
      if (!exp || dflt) continue;
      let id = null;
      if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) id = st.name;
      else if (ts.isVariableStatement(st) && st.declarationList.declarations.length === 1 && ts.isIdentifier(st.declarationList.declarations[0].name)) id = st.declarationList.declarations[0].name;
      if (!id || id.text.length < 4) continue;
      out.push({ name: id.text, file, pos: id.getStart(sf) });
    }
  }
  return out;
}
const contents = new Map(repo.codeFiles.map((f) => [f, repo.read(f)]));
function grepFiles(name) {
  const re = new RegExp(`(^|[^A-Za-z0-9_$])${name.replace(/\$/g, '\\$')}([^A-Za-z0-9_$]|$)`);
  return repo.codeFiles.filter((f) => re.test(contents.get(f))).sort();
}
function renameInfo(c) {
  const locs = repo.ls.findRenameLocations(path.join(repo.dir, c.file), c.pos, false, false, { providePrefixAndSuffixTextForRename: false }) || [];
  const byFile = new Map();
  for (const l of locs) {
    const f = repo.rel(l.fileName);
    if (!repo.trackedSet.has(f)) continue;
    const sf = repo.program.getSourceFile(l.fileName);
    const line = sf.getLineAndCharacterOfPosition(l.textSpan.start).line + 1;
    if (!byFile.has(f)) byFile.set(f, []);
    byFile.get(f).push(line);
  }
  const files = [...byFile.keys()].sort();
  // structural features
  const aliasFiles = [];
  const barrelFiles = [];
  const viaBarrelImporters = [];
  for (const f of files) {
    if (f === c.file) continue;
    const sf = repo.program.getSourceFile(path.join(repo.dir, f));
    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st) && st.importClause?.namedBindings && ts.isNamedImports(st.importClause.namedBindings)) {
        for (const el of st.importClause.namedBindings.elements) {
          const imported = (el.propertyName || el.name).text;
          if (imported !== c.name) continue;
          if (el.propertyName) aliasFiles.push(f);
          const mod = repo.checker.getSymbolAtLocation(st.moduleSpecifier);
          const modFile = mod?.declarations?.[0] ? repo.rel(mod.declarations[0].getSourceFile().fileName) : null;
          if (modFile && modFile !== c.file) viaBarrelImporters.push(`${f} <- ${modFile}`);
        }
      }
      if (ts.isExportDeclaration(st) && st.moduleSpecifier && st.exportClause && ts.isNamedExports(st.exportClause)) {
        if (st.exportClause.elements.some((el) => (el.propertyName || el.name).text === c.name)) barrelFiles.push(f);
      }
    }
  }
  const grep = grepFiles(c.name);
  return {
    files,
    lines: Object.fromEntries([...byFile].map(([f, ls]) => [f, ls])),
    aliasFiles: [...new Set(aliasFiles)],
    barrelFiles: [...new Set(barrelFiles)],
    viaBarrelImporters,
    grepOnly: grep.filter((f) => !byFile.has(f)),
    grepOnlyTests: grep.filter((f) => !byFile.has(f) && isTestFile(f)),
    renameOnly: files.filter((f) => !grep.includes(f)),
  };
}
const valueDecls = exportedValueDecls();
// duplicates of the same name declared elsewhere make the question wording ambiguous only if the
// question omits the file; questions always name the declaring file.
const ordered = valueDecls
  .map((c) => ({ ...c, order: L.seededKey(repoName, 'rename', `${c.file}#${c.name}`) }))
  .sort((a, b) => (a.order < b.order ? -1 : 1));
const t3 = [];
const LIMIT = Number(process.env.RENAME_LIMIT || 1500);
const prevPath = path.join(__dirname, 'out', `${repoName}.candidates.json`);
const prev = process.env.RENAME_REUSE && fs.existsSync(prevPath) ? JSON.parse(fs.readFileSync(prevPath, 'utf8')).t3 : null;
if (prev) t3.push(...prev);
else for (const c of ordered.slice(0, LIMIT)) {
  const info = renameInfo(c);
  t3.push({ key: `${c.file}#${c.name}`, name: c.name, file: c.file, order: c.order, ...info });
}

const out = { repo: repoName, commit: L.PINNED[repoName], t1, t2, t3, t4, unmatchedApiLiterals: unmatched };
fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'out', `${repoName}.candidates.json`), JSON.stringify(out, null, 1));
console.log(repoName, 't1', t1.length, 't2', t2.length, 't3', t3.length, 't4', t4.length, 'unmatched', unmatched.length);
