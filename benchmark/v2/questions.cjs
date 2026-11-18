const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('../../extension/node_modules/typescript');

const roots = path.resolve(__dirname, '../../../bench-repos');
const revisions = {
  'vercel/ai-chatbot': 'a8989b522fa3672a2ae52f053105e40993b36ca1',
  'mfts/papermark': 'ed19717ec02a1ac79aecf5569159aa9d2d869312'
};
const primitive = file => /(?:^|\/)(?:components\/ui|components\/(?:shared\/)?icons|icons)\//.test(file);
const sorted = items => [...new Set(items)].sort();
const hash = value => createHash('sha256').update(value).digest('hex');

function pageUrl(file) {
  const [router, ...parts] = file.split('/');
  if (!parts.length) return;
  const name = parts.pop().replace(/\.tsx?$/, '');
  if (router === 'app' && name === 'page') {
    return '/' + parts.filter(part => !part.startsWith('(') && !part.startsWith('@')).join('/');
  }
  if (router === 'pages' && parts[0] !== 'api' && !name.startsWith('_')) {
    if (name !== 'index') parts.push(name);
    return '/' + parts.join('/');
  }
}

function candidates(repo, sha) {
  const root = path.join(roots, repo.split('/').at(-1));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(git('rev-parse', 'HEAD').trim(), sha);
  assert.equal(git('status', '--porcelain', '--untracked-files=no'), '');
  const files = git('ls-files', '-z').split('\0').filter(file => /(?<!\.d)\.tsx?$/.test(file));
  const modules = new Map();
  const routes = [];
  const list = Array.from({ length: 10 }, () => []);
  const add = (template, question, answer, subject = '') => {
    answer = sorted(answer);
    if (answer.length) list[template - 1].push({ template, question, answer, subject });
  };
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const data = { file, ast, imports: new Map(), definitions: new Map(), jsx: new Set(), calls: new Set() };
    modules.set(file, data);
    const url = pageUrl(file);
    if (url) routes.push({ file, url });
    const directive = ast.statements[0]?.expression;
    data.client = ts.isStringLiteral(directive ?? ast) && directive.text === 'use client';
    data.server = ts.isStringLiteral(directive ?? ast) && directive.text === 'use server';
    for (const node of ast.statements) {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const spec = node.moduleSpecifier.text;
        const resolved = spec.startsWith('@/') ? spec.slice(2) : spec.startsWith('.')
          ? path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)) : '';
        const named = node.importClause?.namedBindings;
        const imports = named && ts.isNamedImports(named) ? named.elements.map(item =>
          [item.name.text, item.propertyName?.text ?? item.name.text]) : [];
        if (node.importClause?.name) imports.push([node.importClause.name.text, 'default']);
        for (const [local, name] of imports) data.imports.set(local, { base: resolved, name });
      }
      if (ts.isFunctionDeclaration(node) && node.name) data.definitions.set(node.name.text, node);
      if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.initializer &&
              (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) {
            data.definitions.set(declaration.name.text, declaration.initializer);
          }
        }
      }
    }
    function visit(node) {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && ts.isIdentifier(node.tagName)) {
        data.jsx.add(node.tagName.text);
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) data.calls.add(node.expression.text);
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  const imported = (module, local) => {
    const binding = module.imports.get(local);
    if (!binding?.base) return;
    const target = [binding.base, ...['.tsx', '.ts', '/index.tsx', '/index.ts'].map(ext => binding.base + ext)]
      .map(file => modules.get(file)).find(Boolean);
    if (!target) return;
    const name = binding.name === 'default' ? [...target.definitions].find(([, node]) =>
      node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword))?.[0] : binding.name;
    return name && { module: target, name };
  };
  const renderedBy = (module, name) => {
    const tags = new Set();
    const walk = node => {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && ts.isIdentifier(node.tagName)) {
        tags.add(node.tagName.text);
      }
      ts.forEachChild(node, walk);
    };
    const definition = module.definitions.get(name);
    if (definition) walk(definition);
    return tags;
  };
  const callers = { jsx: new Map(), calls: new Map() };
  for (const module of modules.values()) {
    for (const kind of ['jsx', 'calls']) {
      for (const local of module[kind]) {
        const reference = imported(module, local);
        if (!reference || module === reference.module) continue;
        const key = reference.module.file + '#' + reference.name;
        if (!callers[kind].has(key)) callers[kind].set(key, new Set());
        callers[kind].get(key).add(module.file);
      }
    }
  }
  const uses = (target, name, kind) => [...(callers[kind].get(target.file + '#' + name) ?? [])];
  const components = new Map();
  const hooks = new Map();
  const actions = new Map();
  for (const module of modules.values()) {
    for (const [name, node] of module.definitions) {
      const table = /^use[A-Z]/.test(name) ? hooks : /^[A-Z]/.test(name) && module.file.endsWith('.tsx')
        ? components : module.server && node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) &&
          node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ? actions : null;
      if (table) table.set(name, table.has(name) ? null : module);
    }
  }
  for (const [name, module] of components) {
    if (!module) continue;
    const callers = uses(module, name, 'jsx');
    if (!primitive(module.file) && callers.length >= 3 && callers.length <= 8) add(1,
      `Which TSX files directly render ${name} in JSX? Exclude its definition file.`, callers, name);
    const pageUrls = routes.filter(route => {
      const page = modules.get(route.file);
      return [...page.jsx].some(local => {
        const first = imported(page, local);
        return first?.module === module && first.name === name || first && [...renderedBy(first.module, first.name)].some(child => {
          const second = imported(first.module, child);
          return second?.module === module && second.name === name;
        });
      });
    }).map(route => route.url);
    if (!primitive(module.file) && pageUrls.length >= 3 && pageUrls.length <= 8) add(10,
      `Which page URLs render ${name} directly or through one directly rendered imported component? Exclude layouts.`, pageUrls, name);
  }
  for (const [name, module] of hooks) {
    if (!module) continue;
    const callers = uses(module, name, 'calls');
    if (callers.length >= 2 && callers.length <= 6) add(2,
      `Which files call the project hook ${name}? Exclude its definition file.`, callers, name);
    for (const directory of ['app', 'components/chat', 'ee', 'pages']) {
      const client = callers.filter(file => file.startsWith(directory + '/') && modules.get(file).client);
      if (client.length >= 2 && client.length <= 8) add(8,
        `Which files under ${directory}/ declare 'use client' and call the project hook ${name}?`, client, name);
    }
  }
  for (const [name, module] of actions) {
    if (!module) continue;
    const callers = uses(module, name, 'calls');
    if (callers.length >= 1 && callers.length <= 8) add(3,
      `Which files directly call the server action ${name}? Include modules without components.`, callers, name);
  }
  for (const route of routes) {
    const page = modules.get(route.file);
    const intermediates = [...page.jsx].map(local => imported(page, local)).filter(Boolean);
    const children = new Map();
    for (const intermediate of intermediates) {
      for (const child of renderedBy(intermediate.module, intermediate.name)) {
        const target = imported(intermediate.module, child);
        if (!target || primitive(target.module.file) || components.get(target.name) !== target.module) continue;
        if (!children.has(target.name)) children.set(target.name, []);
        children.get(target.name).push(intermediate.name);
      }
    }
    for (const [name, inputs] of children) {
      if (sorted(inputs).length >= 2 && sorted(inputs).length <= 8) add(7,
        `Which imported project components directly rendered by the ${route.url} page file themselves directly render ${name}? Exclude layouts. Return component names.`,
        inputs, name);
    }
  }
  return list;
}

// Quotas are per template, with a shared seed and eligibility rules for both repositories.
const selection = {
  'vercel/ai-chatbot': [[1, 4], [8, 2], [2, 3], [3, 1]],
  'mfts/papermark': [[1, 2], [2, 2], [7, 2], [8, 2], [10, 2]]
};
const seed = '20261119';
const questions = [];
for (const [repo, sha] of Object.entries(revisions)) {
  const pools = candidates(repo, sha);
  const subjects = new Set();
  for (const [template, quota] of selection[repo]) {
    const fileAnswer = [1, 2, 3, 8].includes(template);
    const key = text => text.replace(/[^a-z0-9]/gi, '').toLowerCase();
    const valid = pools[template - 1].filter(({ answer, subject }) => !fileAnswer ||
      answer.every(file => !key(file).includes(key(subject))));
    const areas = item => fileAnswer ? new Set(item.answer.map(file => file.split('/')[0])).size : 0;
    valid.sort((a, b) =>
      (Number(areas(b) > 1) - Number(areas(a) > 1)) ||
      hash(seed + a.question).localeCompare(hash(seed + b.question)));
    if (process.argv[2] === 'survey') {
      console.log(repo, template, valid.length, valid.map(item => item.subject).slice(0, 12));
    }
    let picked = 0;
    for (const { subject, ...item } of valid) {
      if (subjects.has(subject)) continue;
      subjects.add(subject);
      questions.push({ id: `q${String(questions.length + 1).padStart(2, '0')}`, repo, ...item });
      if (++picked === quota) break;
    }
    assert.equal(picked, quota, `${repo} T${template} has too few eligible candidates`);
  }
}

if (process.argv[2] !== 'survey') {
  const content = questions.map(item => JSON.stringify(item) + '\n').join('');
  const questionFile = path.join(__dirname, 'questions.jsonl');
  const freezeFile = path.join(__dirname, 'questions.sha256');
  const digest = hash(content) + '  questions.jsonl\n';
  if (process.argv[2] === 'freeze') {
    assert.ok(!fs.existsSync(questionFile) && !fs.existsSync(freezeFile), 'Questions already frozen');
    fs.writeFileSync(questionFile, content, { flag: 'wx' });
    fs.writeFileSync(freezeFile, digest, { flag: 'wx' });
  } else {
    assert.equal(fs.readFileSync(questionFile, 'utf8'), content, 'Frozen questions differ from pinned sources');
    assert.equal(fs.readFileSync(freezeFile, 'utf8'), digest, 'Frozen SHA-256 mismatch');
    console.log(`Verified ${questions.length} frozen questions against pinned source`);
  }
}
