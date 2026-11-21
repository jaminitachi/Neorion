'use strict';
// Ground truth for the two hand-written v6 tasks, computed with the TypeScript compiler API only.
//   T7 (concept location): outgoing webhook signing path.
//   T6 (control): files that read process.env.VERCEL_API_KEY.
// Usage: node handwritten.cjs -> out/dub.handwritten.json
const L = require('./lib.cjs');
const { ts, fs, path } = L;
const repo = new L.Repo('dub');
const isTestFile = (f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f) || /(^|\/)(__tests__|__mocks__)\//.test(f) || /^(playwright|integration|tests)\//.test(f);

function declPos(file, name) {
  const sf = repo.program.getSourceFile(path.join(repo.dir, file));
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === name) return d.name.getStart(sf);
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name && st.name.text === name) return st.name.getStart(sf);
  }
  throw new Error(`${name} not found in ${file}`);
}
// Every reference of a declaration, grouped by file (aliases and re-exports are followed by the language service).
function refsByFile(file, name) {
  const refs = repo.ls.findReferences(path.join(repo.dir, file), declPos(file, name)) || [];
  const out = {};
  for (const r of refs) for (const e of r.references) {
    const f = repo.rel(e.fileName);
    if (!repo.trackedSet.has(f)) continue;
    const sf = repo.program.getSourceFile(e.fileName);
    (out[f] = out[f] || []).push(sf.getLineAndCharacterOfPosition(e.textSpan.start).line + 1);
  }
  return out;
}
function exportedValueNames(file) {
  const sf = repo.program.getSourceFile(path.join(repo.dir, file));
  const mod = repo.checker.getSymbolAtLocation(sf);
  return repo.checker.getExportsOfModule(mod).filter((s) => s.flags & ts.SymbolFlags.Value).map((s) => s.name);
}

// == T7 ==
const SIGN_FILE = 'lib/webhook/signature.ts';
const SIGN_FN = 'createWebhookSignature';
const signRefs = refsByFile(SIGN_FILE, SIGN_FN);
const attachFiles = Object.keys(signRefs).filter((f) => f !== SIGN_FILE);
if (attachFiles.length !== 1) throw new Error('expected exactly one file calling the signer: ' + attachFiles);
const attachFile = attachFiles[0];
// confirm the attach file puts the signature into a headers object
const attachSrc = repo.read(attachFile);
if (!/headers:\s*\{[\s\S]*?"Dub-Signature":\s*signature/.test(attachSrc)) throw new Error('signature header not found');
const attachExports = exportedValueNames(attachFile);
const callerRefs = {};
for (const name of attachExports) callerRefs[name] = refsByFile(attachFile, name);
const callers = new Set();
for (const m of Object.values(callerRefs)) for (const f of Object.keys(m)) if (f !== attachFile && !isTestFile(f)) callers.add(f);
const t7 = {
  signFile: SIGN_FILE, signFn: SIGN_FN, signRefs, attachFile, attachExports, callerRefs,
  testCallersExcluded: [...new Set(Object.values(callerRefs).flatMap((m) => Object.keys(m)).filter(isTestFile))],
  files: [...new Set([SIGN_FILE, attachFile, ...callers])].sort(),
};

// == T6 control ==
const ENV = 'VERCEL_API_KEY';
const envHits = {};
for (const sf of repo.sourceFiles()) {
  const f = repo.rel(sf.fileName);
  const visit = (n) => {
    let hit = false;
    const isProcessEnv = (e) => e && ts.isPropertyAccessExpression(e) && e.name.text === 'env' && e.expression.getText(sf) === 'process';
    if (ts.isPropertyAccessExpression(n) && n.name.text === ENV && isProcessEnv(n.expression)) hit = true;
    if (ts.isElementAccessExpression(n) && isProcessEnv(n.expression) && ts.isStringLiteralLike(n.argumentExpression) && n.argumentExpression.text === ENV) hit = true;
    if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && isProcessEnv(n.initializer) && n.name.elements.some((el) => (el.propertyName || el.name).getText(sf) === ENV)) hit = true;
    if (hit) (envHits[f] = envHits[f] || []).push(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
    ts.forEachChild(n, visit);
  };
  visit(sf);
}
const textHits = repo.codeFiles.filter((f) => repo.read(f).includes(ENV)).sort();
const t6 = { env: ENV, reads: envHits, files: Object.keys(envHits).sort(), textHits };
if (JSON.stringify(t6.files) !== JSON.stringify(textHits)) throw new Error('AST and text disagree: ' + JSON.stringify({ a: t6.files, textHits }));

fs.writeFileSync(path.join(__dirname, 'out', 'dub.handwritten.json'), JSON.stringify({ t7, t6 }, null, 1));
console.log(JSON.stringify({ t7: t7.files, t7exports: attachExports, t7tests: t7.testCallersExcluded, t6: t6.files }, null, 1));
