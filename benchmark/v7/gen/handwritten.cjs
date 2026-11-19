'use strict';
// Ground truth for the four hand-picked v7 tasks (rallly apps/web), computed with the TypeScript compiler API only.
//   T7a (concept location): public REST API key hashing and verification path.
//   T7b (concept location): one-click unsubscribe token path in notification emails.
//   T6  (control): files that read the environment variable NEXT_PUBLIC_TURNSTILE_SITE_KEY.
//   T8  (control): files that use the translation key pollClosedDescription.
// Usage: node handwritten.cjs -> out/rallly.handwritten.json
const L = require('./lib.cjs');
const { ts, fs, path } = L;
const repo = new L.Repo('rallly');
const isTestFile = (f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f) || /(^|\/)(__tests__|__mocks__)\//.test(f) || /^tests\//.test(f) || /^src\/test\//.test(f);

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
const otherFiles = (m, self) => Object.keys(m).filter((f) => f !== self);
const nonTest = (fs_) => fs_.filter((f) => !isTestFile(f));
// Exported top-level functions of `file` whose body references `targetName` declared in `targetFile`.
function exportedCallersIn(file, targetFile, targetName) {
  const lines = refsByFile(targetFile, targetName)[file] || [];
  const sf = repo.program.getSourceFile(path.join(repo.dir, file));
  const out = [];
  for (const st of sf.statements) {
    const exp = (st.modifiers || []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exp) continue;
    const name = L.topLevelName(st);
    const a = sf.getLineAndCharacterOfPosition(st.getStart(sf)).line + 1;
    const b = sf.getLineAndCharacterOfPosition(st.getEnd()).line + 1;
    if (lines.some((l) => l >= a && l <= b)) out.push(name);
  }
  return out;
}

// == T7a: API key hashing and verification ==
const KEY_FILE = 'src/features/api-keys/utils.ts';
const keyExports = exportedValueNames(KEY_FILE);
const keyRefs = Object.fromEntries(keyExports.map((n) => [n, refsByFile(KEY_FILE, n)]));
const keyUsers = [...new Set(Object.values(keyRefs).flatMap((m) => nonTest(otherFiles(m, KEY_FILE))))].sort();
const VERIFY_FN = 'verifyApiKey';
const verifierFiles = nonTest(otherFiles(keyRefs[VERIFY_FN], KEY_FILE));
if (verifierFiles.length !== 1) throw new Error('expected one verifier file: ' + verifierFiles);
const verifierFile = verifierFiles[0];
const verifierExports = exportedValueNames(verifierFile);
// exported values of the verifier file whose definition uses the verification (directly or through local helpers)
const verifierExportRefs = Object.fromEntries(verifierExports.map((n) => [n, refsByFile(verifierFile, n)]));
const t7aCallers = [...new Set(Object.values(verifierExportRefs).flatMap((m) => nonTest(otherFiles(m, verifierFile))))];
const t7a = {
  keyFile: KEY_FILE, keyExports, keyRefs, keyUsers, verifierFile, verifierExports, verifierExportRefs,
  testFilesExcluded: [...new Set([...Object.values(keyRefs), ...Object.values(verifierExportRefs)].flatMap((m) => Object.keys(m)).filter(isTestFile))].sort(),
  files: [...new Set([KEY_FILE, ...keyUsers, ...t7aCallers])].sort(),
};

// == T7b: unsubscribe token ==
const SIG_FILE = 'src/lib/signature.ts';
const TOK_FILE = 'src/features/notifications/utils.ts';
const sigRefs = { createSignature: refsByFile(SIG_FILE, 'createSignature'), verifySignature: refsByFile(SIG_FILE, 'verifySignature') };
const CREATE = 'createUnsubscribeToken';
const PARSE = 'parseUnsubscribeToken';
const createRefs = refsByFile(TOK_FILE, CREATE);
const parseRefs = refsByFile(TOK_FILE, PARSE);
const createCallers = nonTest(otherFiles(createRefs, TOK_FILE)).sort();
const parseCallers = nonTest(otherFiles(parseRefs, TOK_FILE)).sort();
const parseWrappers = {}; // file -> exported functions that call the parse function
for (const f of parseCallers) parseWrappers[f] = exportedCallersIn(f, TOK_FILE, PARSE);
const wrapperRefs = {};
for (const [f, names] of Object.entries(parseWrappers)) for (const n of names) wrapperRefs[`${f}#${n}`] = refsByFile(f, n);
const wrapperCallers = [...new Set(Object.entries(wrapperRefs).flatMap(([k, m]) => nonTest(otherFiles(m, k.split('#')[0]))))];
const t7b = {
  sigFile: SIG_FILE, sigRefs, tokenFile: TOK_FILE, createRefs, parseRefs, createCallers, parseCallers, parseWrappers, wrapperRefs,
  otherSignatureUsers: [...new Set(Object.values(sigRefs).flatMap((m) => Object.keys(m)))].filter((f) => f !== SIG_FILE && f !== TOK_FILE && !isTestFile(f)),
  files: [...new Set([SIG_FILE, TOK_FILE, ...createCallers, ...parseCallers, ...wrapperCallers])].sort(),
};

// == T6 control: environment variable reads ==
const ENV = 'NEXT_PUBLIC_TURNSTILE_SITE_KEY';
const ENV_MODULE = 'src/env.ts';
const envHits = {};
for (const sf of repo.sourceFiles()) {
  const f = repo.rel(sf.fileName);
  const visit = (n) => {
    let hit = false;
    const isProcessEnv = (e) => e && ts.isPropertyAccessExpression(e) && e.name.text === 'env' && e.expression.getText(sf) === 'process';
    // the validated env object exported by src/env.ts
    const isEnvObject = (e) => {
      if (!e || !ts.isIdentifier(e)) return false;
      const sym = repo.checker.getSymbolAtLocation(e);
      const key = sym ? L.declKey(repo, sym) : null;
      return key === `${ENV_MODULE}#env`;
    };
    if (ts.isPropertyAccessExpression(n) && n.name.text === ENV && (isProcessEnv(n.expression) || isEnvObject(n.expression))) hit = true;
    if (ts.isElementAccessExpression(n) && isProcessEnv(n.expression) && ts.isStringLiteralLike(n.argumentExpression) && n.argumentExpression.text === ENV) hit = true;
    if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && (isProcessEnv(n.initializer) || isEnvObject(n.initializer)) && n.name.elements.some((el) => (el.propertyName || el.name).getText(sf) === ENV)) hit = true;
    if (hit) (envHits[f] = envHits[f] || []).push(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
    ts.forEachChild(n, visit);
  };
  visit(sf);
}
const envText = repo.codeFiles.filter((f) => repo.read(f).includes(ENV)).sort();
const t6 = { env: ENV, reads: envHits, files: Object.keys(envHits).sort(), textHits: envText };
if (JSON.stringify(t6.files) !== JSON.stringify(envText)) throw new Error('T6 AST and text disagree: ' + JSON.stringify({ a: t6.files, envText }));

// == T8 control: translation key uses ==
const KEY = 'pollClosedDescription';
const keyHits = {};
for (const sf of repo.sourceFiles()) {
  const f = repo.rel(sf.fileName);
  const visit = (n) => {
    if (ts.isStringLiteralLike(n) && n.text === KEY) {
      const p = n.parent;
      const isT = ts.isCallExpression(p) && p.arguments[0] === n && /(^|\.)t$/.test(p.expression.getText(sf));
      const isAttr = ts.isJsxAttribute(p) && p.name.getText(sf) === 'i18nKey';
      const kind = isT ? 't()' : isAttr ? 'i18nKey' : 'other';
      (keyHits[f] = keyHits[f] || []).push(`${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} ${kind}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}
const keyText = repo.codeFiles.filter((f) => repo.read(f).includes(KEY)).sort();
const t8 = { key: KEY, uses: keyHits, files: Object.keys(keyHits).sort(), textHits: keyText };
if (Object.values(keyHits).flat().some((x) => x.endsWith('other'))) throw new Error('T8 non-translation use: ' + JSON.stringify(keyHits));
if (JSON.stringify(t8.files) !== JSON.stringify(keyText)) throw new Error('T8 AST and text disagree');

fs.writeFileSync(path.join(__dirname, 'out', 'rallly.handwritten.json'), JSON.stringify({ t7a, t7b, t6, t8 }, null, 1));
console.log(JSON.stringify({ t7a: t7a.files, t7aTests: t7a.testFilesExcluded, t7b: t7b.files, t7bWrappers: t7b.parseWrappers, t7bOther: t7b.otherSignatureUsers, t6: t6.files, t6reads: t6.reads, t8: t8.files }, null, 1));
