'use strict';
// Independent ground-truth core for benchmark v6 (copied from v4 gen; only the target constants changed).
// Uses only the TypeScript compiler API (typescript@5.6.3 pinned in gen/package.json).
// Does not import or read any Neorion analyzer code.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const ts = require('typescript');

const REPOS_DIR = path.resolve(__dirname, '../../bench-repos');
// v4 target: one Next.js app inside a monorepo. Paths in tasks are relative to APP_SUBDIR.
const PINNED = {
  dub: '6b463b4bdd9ed2fd9aa416f67b5b77d317b1471e',
};
const APP_SUBDIR = { dub: 'apps/web' };
// tsconfig "extends" targets a workspace package that is only reachable through node_modules,
// which the benchmark copy does not have. Resolve it to the tracked source file instead.
const EXTENDS_FALLBACK = { dub: { 'tsconfig/nextjs.json': 'packages/tsconfig/nextjs.json' } };
const SEED = 'neorion-bench-v6-20261119';
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}
function seededKey(...parts) {
  return sha256([SEED, ...parts].join('|'));
}

function checkPinned(repo) {
  const dir = path.join(REPOS_DIR, repo);
  const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD']).toString().trim();
  if (head !== PINNED[repo]) throw new Error(`${repo} HEAD ${head} != pinned ${PINNED[repo]}`);
  const dirty = execFileSync('git', ['-C', dir, 'status', '--porcelain', '--untracked-files=no']).toString().trim();
  if (dirty) throw new Error(`${repo} has modified tracked files`);
  return dir;
}

// Only git-tracked files at the pinned commit. Untracked artifacts (for example
// a generated graph) are never seen by the generator.
function trackedFiles(dir) {
  return execFileSync('git', ['-C', dir, 'ls-files', '-z', '--', '.'])
    .toString()
    .split('\0')
    .filter(Boolean);
}

class Repo {
  constructor(name) {
    this.name = name;
    this.root = checkPinned(name);
    this.dir = path.join(this.root, APP_SUBDIR[name]);
    this.tracked = trackedFiles(this.dir);
    this.codeFiles = this.tracked.filter((f) => CODE_EXT.test(f) && !f.startsWith('public/'));
    const cfgPath = path.join(this.dir, 'tsconfig.json');
    const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile);
    const fb = (EXTENDS_FALLBACK[name] || {})[cfg.config.extends];
    if (fb) cfg.config.extends = path.join(this.root, fb);
    const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, this.dir);
    this.options = { ...parsed.options, noEmit: true, skipLibCheck: true, incremental: false, allowJs: true };
    delete this.options.tsBuildInfoFile;
    this.rootNames = this.codeFiles.map((f) => path.join(this.dir, f));
    this.trackedSet = new Set(this.codeFiles);
    this._program = null;
    this._ls = null;
  }
  rel(abs) {
    return path.relative(this.dir, abs).split(path.sep).join('/');
  }
  isLocal(sf) {
    if (!sf) return false;
    const r = this.rel(sf.fileName);
    return this.trackedSet.has(r);
  }
  get program() {
    if (!this._program) this._program = ts.createProgram(this.rootNames, this.options);
    return this._program;
  }
  get checker() {
    return this.program.getTypeChecker();
  }
  get ls() {
    if (!this._ls) {
      const versions = new Map();
      const host = {
        getScriptFileNames: () => this.rootNames,
        getScriptVersion: () => '1',
        getScriptSnapshot: (f) => {
          if (!fs.existsSync(f)) return undefined;
          return ts.ScriptSnapshot.fromString(fs.readFileSync(f, 'utf8'));
        },
        getCurrentDirectory: () => this.dir,
        getCompilationSettings: () => this.options,
        getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
        fileExists: ts.sys.fileExists,
        readFile: ts.sys.readFile,
        readDirectory: ts.sys.readDirectory,
        directoryExists: ts.sys.directoryExists,
        getDirectories: ts.sys.getDirectories,
      };
      void versions;
      this._ls = ts.createLanguageService(host, ts.createDocumentRegistry());
    }
    return this._ls;
  }
  sourceFiles() {
    return this.program.getSourceFiles().filter((sf) => this.isLocal(sf));
  }
  read(rel) {
    return fs.readFileSync(path.join(this.dir, rel), 'utf8');
  }
}

// == declarations ==

function topLevelOf(node) {
  let n = node;
  while (n.parent && !ts.isSourceFile(n.parent)) n = n.parent;
  return n.parent ? n : null;
}

function topLevelName(stmt) {
  if (!stmt) return null;
  const isDefault = (stmt.modifiers || []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
  if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) {
    return stmt.name ? stmt.name.text : isDefault ? 'default' : null;
  }
  if (ts.isVariableStatement(stmt)) {
    const d = stmt.declarationList.declarations[0];
    return d && ts.isIdentifier(d.name) ? d.name.text : null;
  }
  if (ts.isExportAssignment(stmt)) return 'default';
  if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt) || ts.isEnumDeclaration(stmt)) return stmt.name.text;
  return null;
}

function resolveSymbol(checker, sym) {
  let s = sym;
  let guard = 0;
  while (s && s.flags & ts.SymbolFlags.Alias && guard++ < 20) {
    try {
      s = checker.getAliasedSymbol(s);
    } catch {
      break;
    }
  }
  return s;
}

// Map a symbol to "file#topLevelName" when it is declared in a tracked project file.
function declKey(repo, sym) {
  const checker = repo.checker;
  const s = resolveSymbol(checker, sym);
  if (!s || !s.declarations || !s.declarations.length) return null;
  for (const d of s.declarations) {
    const sf = d.getSourceFile();
    if (!repo.isLocal(sf)) continue;
    if (ts.isSourceFile(d)) return null;
    // export default <identifier> resolves to that identifier's declaration
    const tl = topLevelOf(d);
    if (!tl) continue;
    if (ts.isExportAssignment(tl) && ts.isIdentifier(tl.expression)) {
      const inner = checker.getSymbolAtLocation(tl.expression);
      if (inner && inner !== sym) return declKey(repo, inner);
    }
    const name = topLevelName(tl);
    if (!name) continue;
    return `${repo.rel(sf.fileName)}#${name}`;
  }
  return null;
}

function moduleExportKey(repo, moduleSym, exportName) {
  const checker = repo.checker;
  if (!moduleSym) return null;
  const exp = checker.getExportsOfModule(moduleSym).find((e) => e.escapedName === exportName);
  return exp ? declKey(repo, exp) : null;
}

// == edges ==

function buildGraph(repo) {
  const checker = repo.checker;
  const render = new Map(); // from -> Map(to -> evidence)
  const refs = new Map(); // from -> Set(to)
  const nodesByFile = new Map(); // file -> Set(names)
  const add = (m, a, b, ev) => {
    if (!a || !b || a === b) return;
    if (!m.has(a)) m.set(a, new Map());
    if (!m.get(a).has(b)) m.get(a).set(b, ev);
  };
  for (const sf of repo.sourceFiles()) {
    const file = repo.rel(sf.fileName);
    const names = new Set();
    for (const st of sf.statements) {
      const n = topLevelName(st);
      if (n) names.add(n);
    }
    nodesByFile.set(file, names);
    const visit = (node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName;
        const txt = tag.getText(sf);
        if (!/^[a-z]/.test(txt) || txt.includes('.')) {
          const sym = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(tag) ? tag.name : tag);
          const to = sym ? declKey(repo, sym) : null;
          const tl = topLevelOf(node);
          const from = tl ? `${file}#${topLevelName(tl)}` : null;
          if (to && from) {
            const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
            add(render, from, to, `${file}:${line} <${txt}>`);
          }
        }
      }
      // re-export statements (`export { default } from "x"`, `export { A as B } from "x"`) make the
      // exported name of this file stand for the target declaration
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) {
          const target = checker.getExportSpecifierLocalTargetSymbol(el);
          const to = target ? declKey(repo, target) : null;
          const from = `${file}#${el.name.text}`;
          if (to && to !== from) {
            const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
            add(render, from, to, `${file}:${line} re-export ${el.name.text}`);
            add(refs, from, to, true);
          }
        }
      }
      // next/dynamic style: import("spec").then((m) => m.Name) or default
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length) {
        const modSym = checker.getSymbolAtLocation(node.arguments[0]);
        let exportName = 'default';
        const p = node.parent;
        if (p && ts.isPropertyAccessExpression(p) && p.name.text === 'then' && ts.isCallExpression(p.parent)) {
          const cb = p.parent.arguments[0];
          if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) {
            const body = cb.body;
            const expr = ts.isBlock(body) ? null : body;
            if (expr && ts.isPropertyAccessExpression(expr)) exportName = expr.name.text;
          }
        }
        const to = moduleExportKey(repo, modSym, exportName);
        const tl = topLevelOf(node);
        const from = tl ? `${file}#${topLevelName(tl)}` : null;
        if (to && from) {
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
          add(render, from, to, `${file}:${line} dynamic import ${exportName}`);
        }
      }
      if (ts.isIdentifier(node) && !ts.isImportSpecifier(node.parent) && !ts.isImportClause(node.parent) && !ts.isExportSpecifier(node.parent)) {
        const tl = topLevelOf(node);
        if (tl && !ts.isImportDeclaration(tl) && !ts.isExportDeclaration(tl)) {
          const sym = checker.getSymbolAtLocation(node);
          if (sym && !(sym.flags & ts.SymbolFlags.Type && !(sym.flags & ts.SymbolFlags.Value))) {
            const to = declKey(repo, sym);
            const from = `${file}#${topLevelName(tl)}`;
            if (to && to !== from) add(refs, from, to, true);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { render, refs, nodesByFile };
}

function reverse(m) {
  const r = new Map();
  for (const [a, tos] of m) for (const [b, ev] of tos) {
    if (!r.has(b)) r.set(b, new Map());
    r.get(b).set(a, ev);
  }
  return r;
}

// == routes ==

function pageRoute(file) {
  let m;
  if ((m = file.match(/^(?:src\/)?pages\/(.+)\.(tsx|ts|jsx|js)$/))) {
    const p = m[1];
    if (p.startsWith('api/') || /^_(app|document|error)$/.test(p)) return null;
    let url = '/' + p.replace(/(^|\/)index$/, '');
    url = url.replace(/\/$/, '') || '/';
    return url;
  }
  if ((m = file.match(/^(?:src\/)?app\/((?:.*\/)?)page\.(tsx|ts|jsx|js)$/))) {
    if (m[1].split('/').some((s) => s.startsWith('_'))) return null; // private folders are not routable
    const segs = m[1].split('/').filter(Boolean).filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith('@'));
    return '/' + segs.join('/');
  }
  return null;
}

function apiRoute(file) {
  let m;
  if ((m = file.match(/^(?:src\/)?pages\/(api\/.+)\.(ts|js)$/))) {
    return '/' + m[1].replace(/\/index$/, '');
  }
  if ((m = file.match(/^(?:src\/)?app\/((?:.*\/)?)route\.(ts|tsx|js)$/))) {
    if (m[1].split('/').some((s) => s.startsWith('_'))) return null;
    const segs = m[1].split('/').filter(Boolean).filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith('@'));
    const url = '/' + segs.join('/');
    return url.startsWith('/api/') || url === '/api' ? url : null;
  }
  return null;
}

module.exports = {
  ts, fs, path, Repo, PINNED, APP_SUBDIR, SEED, sha256, seededKey, topLevelOf, topLevelName,
  resolveSymbol, declKey, buildGraph, reverse, pageRoute, apiRoute, REPOS_DIR,
};
