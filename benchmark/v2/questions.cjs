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
const methods = /^(GET|HEAD|POST|PUT|DELETE|PATCH|OPTIONS)$/;
const sorted = items => [...new Set(items)].sort();
const hash = value => createHash('sha256').update(value).digest('hex');

function routeFor(file, source) {
  const [router, ...parts] = file.split('/');
  if (!parts.length) return;
  const name = parts.pop().replace(/\.tsx?$/, '');
  if (router === 'app' && ['page', 'route'].includes(name)) {
    return { file, router, page: name === 'page',
      url: '/' + parts.filter(part => !part.startsWith('(') && !part.startsWith('@')).join('/'),
      methods: sorted([...source.matchAll(/^export (?:async )?(?:function |const )([A-Z]+)\b/gm)]
        .map(match => match[1]).filter(name => methods.test(name))) };
  }
  if (router === 'pages' && !name.startsWith('_')) {
    const page = parts[0] !== 'api';
    if (name !== 'index') parts.push(name);
    return { file, router, page, url: '/' + parts.join('/'), methods: page ? [] :
      sorted([...source.matchAll(/\b\w+\.method\s*[!=]={1,2}\s*["']([A-Z]+)["']|\bcase\s+["']([A-Z]+)["']/g)]
        .map(match => match[1] ?? match[2]).filter(name => methods.test(name))) };
  }
}

function matchRoute(pattern, url) {
  const actual = url.split('/').slice(1);
  const expected = pattern.split('/').slice(1);
  for (let i = 0; i < expected.length; i++) {
    if (expected[i].startsWith('[[...')) return true;
    if (expected[i].startsWith('[...')) return Boolean(actual[i]);
    if (expected[i].startsWith('[') ? !actual[i] : expected[i] !== actual[i]) return false;
  }
  return actual.length === expected.length;
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
    const route = routeFor(file, source);
    if (route) routes.push(route);
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
  const uses = (target, name, kind) => [...modules.values()].filter(module => module !== target &&
    [...module[kind]].some(local => {
      const reference = imported(module, local);
      return reference?.module === target && reference.name === name;
    })).map(module => module.file);
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
    const parameter = module.definitions.get(name).parameters[0]?.name;
    if (parameter && ts.isObjectBindingPattern(parameter)) {
      const props = parameter.elements.filter(element => !element.dotDotDotToken)
        .map(element => (element.propertyName ?? element.name).getText());
      if (props.length >= 2 && props.length <= 8 && callers.length) add(9,
        `What prop names does ${name} destructure in its first parameter? Exclude the rest binding. The component is under ${path.posix.dirname(module.file)}/.`, props, name);
    }
    const pageUrls = routes.filter(route => route.page && (() => {
      const page = modules.get(route.file);
      return [...page.jsx].some(local => {
        const first = imported(page, local);
        return first?.module === module && first.name === name || first && [...renderedBy(first.module, first.name)].some(child => {
          const second = imported(first.module, child);
          return second?.module === module && second.name === name;
        });
      });
    })()).map(route => route.url);
    if (!primitive(module.file) && pageUrls.length >= 2 && pageUrls.length <= 8) add(10,
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
    if (!route.page && route.url.includes('[')) {
      const url = route.url.replace(/\[\[\.\.\.[^\]]+\]\]|\[(?:\.\.\.)?[^\]]+\]/g, 'example');
      for (const method of route.methods) {
        const matches = routes.filter(other => !other.page && matchRoute(other.url, url))
          .sort((a, b) => Number(b.router === 'app') - Number(a.router === 'app') ||
            a.url.split('[').length - b.url.split('[').length);
        if (matches[0] === route) add(4,
          `Which source file handles ${method} ${url}? Return the one matching API file.`, [route.file], route.url);
      }
    }
    if (route.router === 'pages' && !route.page && route.methods.length >= 2) add(6,
      `Which HTTP methods does the Pages Router API ${route.url} explicitly branch on?`, route.methods, route.url);
    if (!route.page) continue;
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
  for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    const urls = sorted(routes.filter(route => route.file.startsWith('app/api/') && route.methods.includes(method))
      .map(route => route.url));
    if (urls.length >= 4 && urls.length <= 8) add(5,
      `Which App Router endpoints under app/api/ explicitly export ${method}? Return URL patterns.`, urls, method);
  }
  return list;
}

const selection = {
  'vercel/ai-chatbot': [2, 3, 4, 8, 9],
  'mfts/papermark': [1, 5, 6, 7, 10]
};
const seed = '20261119';
const questions = [];
for (const [repo, sha] of Object.entries(revisions)) {
  const pools = candidates(repo, sha);
  if (process.argv[2] === 'survey') {
    console.log(repo, pools.map(pool => pool.length));
    for (const template of selection[repo]) console.log(template, pools[template - 1].slice(0, 4));
    continue;
  }
  for (const template of selection[repo]) {
    const valid = pools[template - 1].filter(({ answer, subject }) => {
      if (template === 8 && questions.some(item => item.repo === repo && item.question.includes(subject))) return false;
      if (![1, 2, 3, 8].includes(template)) return true;
      return answer.every(file => !file.replace(/[^a-z0-9]/gi, '').toLowerCase()
        .includes(subject.toLowerCase()));
    });
    const areas = item => [1, 2, 3, 8].includes(template)
      ? new Set(item.answer.map(file => file.split('/')[0])).size : 0;
    const specific = template === 3 ? valid.filter(item => item.subject === 'deleteTrailingMessages') : valid;
    const picked = specific.sort((a, b) =>
      (Number(areas(b) > 1) - Number(areas(a) > 1)) ||
      hash(seed + a.question).localeCompare(hash(seed + b.question)))[0];
    assert.ok(picked, `${repo} T${template} has no eligible candidate`);
    const { subject, ...item } = picked;
    questions.push({ id: `q${String(questions.length + 1).padStart(2, '0')}`, repo, ...item });
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
